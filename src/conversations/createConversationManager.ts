import { readTimeoutSetting } from "../state/timeoutBounds";
import { setOptionalProperty } from "../state/optionalProperty";
import {
  conversationOwnedPaths,
  conversationStorageDirectory,
  DEFAULT_CONVERSATION_ID,
} from "../state/localData";
import { normalizeConversationTree } from "./conversationTree";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import type { WorkspaceWriteScope } from "../adapters/types";
import {
  BrowserBridgeStatus,
  createBrowserBridgeServer,
} from "../browser/bridgeServer";
import { BrowserConversationBinding } from "../browser/protocol";
import { DEFAULT_BROWSER_BRIDGE_MAX_MESSAGE_BYTES } from "../browser/limits";
import { pathInsideRelative } from "../process/pathBoundary";
import {
  boundRecheck as recheckBoundTo,
  contractChecksFrom,
  decisionRisks as risksFromDecision,
  executionEventCutoff,
  latestCurrentEvent,
  runWasExecuted,
  validatedOutputRefs,
  verificationProvenance,
} from "./runResultProjection";
import {
  ConversationDeletionManifest,
  isPathAtOrInside,
  parseDeletionManifest as parseManifest,
  plannedRestoreEntries,
  StagedConversationDeletion,
  stagedDeletionDisposition,
} from "./conversationDeletion";
import {
  createRuntime,
  PipelineCatalogChange,
  Runtime,
  RuntimeInteractionFallback,
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
  RuntimeReadinessReport,
} from "../runtime/createRuntime";
import {
  ExecuteChecklistRequest,
  ExecuteChecklistResult,
  PipelineRunResult,
} from "../pipeline/runner";
import {
  mergeRecheckedChecks,
  mergeRunResults,
  projectRunResult,
  runHandoffRefusal,
  runResultHasEvidence,
  type RunRecheckRecord,
  type RunResultCenter,
} from "../results/projectResult";
import { parseRulingProvenance } from "../results/rulingProvenance";
import {
  mergeModelFindings,
  modelFindingsFromDecisionArtifact,
  modelFindingsFromStepOutputArtifact,
} from "../results/modelFindings";
import { createRunBundle } from "../export/runBundle";
import { inspectRunBundleIntegrity } from "../export/runBundleReport";
import {
  boundPatchFiles,
  parsePatchHunkReferences,
  selectionIsEmpty,
  type PatchFileSummary,
  type PatchSelection,
} from "../orchestrator/patchSelection";
import {
  applyConfirmationPolicy,
  applySelectionUnprovenNotice,
} from "./applyConfirmation";
import { extensionVersion } from "../version";
import { renderEvidenceMarkdown, renderEvidenceSarif } from "../export/evidenceReport";
import type { EvidenceReportInput } from "../export/evidenceReport";
import {
  evidenceExclusionOmissions,
  excludeEvidencePaths,
} from "../export/evidenceExclusion";
import {
  applyExportPolicy,
  applyExportPolicyToSchema,
  EXPORT_POLICY_PATH,
  excludeBundlePaths,
  maskExcludedPaths,
  excludedByPolicy,
  loadExportPolicy,
} from "../export/exportPolicy";
import {
  exportConfirmationDetail,
  exportDisclosureRules,
  runExportPlan,
} from "../export/exportPlan";
import {
  executionSafetyLevel,
  producesModelFindings,
  PROPOSED_FINDING_SET_SHAPE,
  RULED_FINDING_SET_SHAPE,
} from "../contract/executionContract";
import {
  runSettingsFingerprint,
  type RunSettingRejection,
  type RunSettingsSnapshot,
} from "../runtime/settingsSnapshot";
import type {
  AuthoredBy,
  ExternalEvidenceAuthority,
  ExternalEvidenceClaimTarget,
  ExternalEvidenceRecord,
  ExternalEvidenceRelation,
  ExternalEvidenceSource,
} from "../longitudinal/types";
import {
  UNKNOWN_EVIDENCE_EXPECTATIONS,
  pipelineEvidenceExpectations,
} from "../results/evidenceExpectations";
import type { EvidenceExpectations } from "../results/evidenceExpectations";
import type { VerificationResult } from "../results/projectResult";
import { runVerificationChecks } from "../orchestrator/commandRunner";
import { configuredProcessEnvironment } from "../process/safeEnvironment";
import type { OnboardingEvent, OnboardingJourney } from "../onboarding/firstRun";
import { historyScan } from "../history/search";
import { providerConversationLocator } from "./conversationLocator";
import { conversationSummaryFromCatalog, conversationSummaryToCatalog } from "./catalogSummary";
import {
  emptyOrchestrationSummary,
  latestCheckStamp,
  summarizeOrchestration,
} from "../orchestrator/summarize";
import type { VerificationCheckResult } from "../orchestrator/types";
import { createNotificationCenter } from "../notifications/center";
import { deriveNotifications } from "../notifications/derive";
import { notificationSourceFrom } from "../notifications/source";
import { notificationMode } from "../notifications/types";
import { createTranscriptStore } from "../state/transcriptStore";
import {
  createPipelineSnapshot,
  pipelineSnapshotRootsEqual,
  PipelineSnapshot,
} from "../pipeline/identity";
import {
  DecisionArtifact,
  PipelineDefinition,
  PipelineStep,
  StepOutputArtifact,
} from "../pipeline/types";
import { createDeadlineScheduler } from "../state/deadlineScheduler";
import { WorkspaceMutationRunner } from "../state/workspaceMutationFence";
import { PipelineCatalogMutationRunner } from "../pipeline/catalogStorage";
import {
  createStateCatalog,
  InteractionRecord,
  RunCatalogRecord,
  RunParticipant,
} from "../state/catalog";
import {
  createReference,
  formatProviderChatTitle,
  formatRunTitle,
  isReference,
  parseRunTitle,
} from "../state/identifiers";
import { decisionSourceFromDecisionArtifact } from "../longitudinal/decisionCandidates";
import { coreDecisionSourceFrom, mergeDecisionSources } from "../longitudinal/coreDecisionSources";
import type { DecisionSourceResult } from "../longitudinal/decisionCandidates";
import { planSourceFromDecisionArtifact } from "../longitudinal/planCandidates";
import type { PlanSourceResult } from "../longitudinal/planCandidates";
import {
  caseFoldedRepositoryIdentities,
  createLongitudinalService,
  repositoryIdentity,
} from "../longitudinal/service";
import type { DeclaredArtifactSource, LongitudinalService } from "../longitudinal/service";
import { declaredArtifactSourcesFor } from "../longitudinal/declaredArtifactSources";
import type { LongitudinalIntent } from "../pipeline/types";
import type { ReviewCandidate } from "../context/reviewScope";
import {
  loadResourceRegistry,
  resourceAvailabilityForLoad,
} from "../pipeline/resourceRegistry";
import { INITIATIVE_BUNDLE_SPEC } from "../longitudinal/bundleSchema";
import {
  parseCycleType,
  parseHumanResolutionAction,
  parseInitiativeBundle,
} from "../longitudinal/parse";
import {
  baselineIdentity,
  baselineIsSameCandidate,
  captureCycleBaseline,
} from "../longitudinal/repositoryBaseline";
import { findingIsActionable } from "../longitudinal/lifecycle";
import type {
  CycleBaseline,
  CycleType,
  FindingHistoryEntry,
  Initiative,
} from "../longitudinal/types";
import {
  AgentPanelState,
  ConversationManagerState,
  ConversationManagerToExtensionMessage,
  ConversationManagerToWebviewMessage,
  ConversationSummary,
  ExtensionToWebviewMessage,
  PanelState,
  WebviewToExtensionMessage,
} from "../webview/protocol";
import { OrchestrationLedger, OrchestrationSnapshot } from "../orchestrator/types";
import { AttachmentMetadata } from "../attachments/attachmentStore";
import {
  ResourceBroker,
  ResourceClaim,
  ResourceLease,
  resourceKey,
} from "../concurrency/resourceBroker";
import {
  mainWorktreeRootFromCommonDir,
  resolveWorkingResourceIdentity,
  type WorkingResourceIdentity,
} from "../concurrency/repositoryResources";
import { chainSerially } from "../state/serialQueue";
import {
  ARCHIVE_ROLLBACK_INCOMPLETE,
  DELETION_ROLLBACK_INCOMPLETE,
  archiveReplacementChoice,
  busyConversationRefusal,
  deletionActiveChoice,
  resumeIterationWindow,
  resumeRefusal,
} from "./conversationLifecycle";
import {
  CHECKLIST_EXECUTION_UNAVAILABLE,
  CHECKLIST_PREFLIGHT_UNAVAILABLE,
  checklistExecutionRefusal,
  conversationRuntimeShape,
} from "./conversationRuntimeOptions";
import {
  impliedWriteScope,
  isPairPipeline,
  iterationEndEvent,
  iterationFailurePlan,
  iterationStartEvent,
  pairRecordFrom,
} from "./iterationExecution";
import {
  checklistStoragePlan,
  interactionContextFrom,
  interactionPayloadHash,
  interactionTimeoutMs,
  responseFromResolution,
  supersededInteractionRefs,
} from "./interactionRequests";
import {
  PIPELINE_CATALOG_REFRESH_DEBOUNCE_MS,
  catalogMutationFailure,
  catalogOwnershipIdentity,
  catalogRefreshFailureMessages,
  catalogRefreshSchedule,
  catalogWatchPatterns,
} from "./pipelineCatalogCoordination";
import {
  freshReviewJourneyEvents,
  roundCandidateFrom,
  roundEligibility,
  roundRecordingDecision,
} from "./longitudinalRound";
import {
  EVENT_WINDOW_START,
  catalogEventView,
  changedFilesFor,
  checksFor,
  finalRulingFor,
  openInteractionView,
  nextEventWindow,
  retainedRunTarget,
  rulingAttribution,
} from "./catalogViews";
import type { LocalAgentDemand } from "./executionLeasePlan";
import {
  checklistSuspensionRefusal,
  continuationLeasePlan,
  executionReleasePlan,
  executionResourceClaims,
  executionStateLeaseIds,
  leaseQuarantineOutcome,
  leaseReleaseFailure,
  localExecutionLease,
  quarantineReasonFor,
  rejectedReasons,
  executionTopUpPlan,
  localAgentDemandRefusal,
  normalizedLocalAgentDemand,
  releaseOnce,
  topUpReservationHolds,
} from "./executionLeasePlan";

export type ConversationCreateOptions = {
  title?: string | undefined;
  reviewCandidate?: ReviewCandidate | undefined;
  input?: string | undefined;
  preparedDraft?: string | undefined;
  pipelineId?: string | undefined;
  pipelineSnapshot?: PipelineSnapshot | undefined;
  iterationCount?: number | undefined;
  workingDirectory?: string | undefined;
  parentConversationId?: string | undefined;
  orchestrationRunId?: string | undefined;
  orchestrationTaskId?: string | undefined;
  orchestrationBranch?: string | undefined;
  orchestrationBaseCommit?: string | undefined;
  orchestrationPaths?: string[] | undefined;
  pipelineScopeRoot?: string | undefined;
  runSettings?: RunSettingsSnapshot | undefined;
};

/**
 * The audit events that are proof a run actually executed.
 *
 * `events.length > 0` was read as that proof, and creating a conversation appends `run.created`
 * — so a room a user had only opened satisfied it. The projection then rendered a Run Result for
 * a run that had never started: no changed files, no verification, a missing-evidence warning and
 * an apply blocker, all about nothing. Membership is stated rather than derived, so an event type
 * added later is not silently treated as execution: an event that records a room's existence, or
 * what resources were declared before anything ran, is not execution.
 */
export const executionProvingEventTypes = new Set([
  "run.started",
  "run.resumed",
  "run.completed",
  "run.interrupted",
  "run.failed",
  "run.resume.failed",
  "iteration.started",
  "iteration.resumed",
  "iteration.failed",
  "iteration.resume.failed",
  "step.started",
  "step.round.started",
  "output.validated",
  "output.invalid",
  "decision.published",
  "verification.completed",
  "interaction.opened",
  "interaction.resolved",
  "interaction.answeredByLead",
  "interaction.timeout",
]);

const exportOmissions = [
  "Attachment file contents are excluded; metadata only.",
  "Provider credentials, cookies, session tokens, provider session identifiers, and conversation identities are excluded.",
  "Links keep only their origin; conversation URL paths, queries, and fragments are removed.",
  "Catalog retention may have pruned older events or structured outputs before export.",
];

export type ConversationExecutionResult = {
  conversationId: string;
  pipeline: PipelineRunResult;
  iterations: PipelineRunResult[];
};

export type ConversationRunOptions = {
  onAccepted?: () => Promise<void> | void;
  onRuntimeAccepted?: () => Promise<void> | void;
  appendPrompt?: boolean;
  sourceQueueMessageId?: string;
  pipelineSnapshot?: PipelineSnapshot;
  commitMode?: "never" | "allow";
  writeScope?: WorkspaceWriteScope;
  iterationMode?: "fixed" | "untilClean";
  requiredCleanPasses?: number;
  composerAuthorized?: boolean;
  requirePipelineHash?: string;
};

export type TodoOrchestrationControl = {
  start: () => Promise<OrchestrationLedger>;
  resume: () => Promise<OrchestrationLedger>;
  stop: () => Promise<void>;
  abandon: () => Promise<void>;
  cleanupRetained: (runId: string) => Promise<void>;
  resolveRetainedWorktree: (runId: string) => Promise<string>;
  retainedRunPatch?: (runId: string, selection?: PatchSelection) => Promise<string>;
  retainedRunPatchFiles?: (runId: string) => Promise<PatchFileSummary[]>;
  rerunRetainedChecks?: (runId: string) => Promise<VerificationCheckResult[]>;
  verifyRetainedSelection?: (
    runId: string,
    selection: PatchSelection,
  ) => Promise<Array<{ command: string; status: string; stdout: string; stderr: string }>>;
  applyRetained?: (runId: string, selection?: PatchSelection) => Promise<{
    applied: boolean;
    targetBranch: string;
    stagedFiles: string[];
    conflicts: string[];
    reason?: string;
  }>;
  getSnapshot: () => OrchestrationSnapshot;
  onDidChange: (listener: (snapshot: OrchestrationSnapshot) => void) => { dispose: () => void };
};

export type ConversationManagerOptions = {
  focusInteraction?: (target: { conversationId: string; interactionRef: string }) => void;
  resourceBroker?: ResourceBroker;
  workspaceLease?: ResourceLease;
  withWorkspaceMutation?: WorkspaceMutationRunner;
};

export type ChecklistExecutionContext = {
  conversationId: string;
  runRef: string;
  title: string;
  workingDirectory: string;
  request: ExecuteChecklistRequest;
};

export type ChecklistPreflightContext = {
  conversationId: string;
  runRef: string;
  title: string;
  workingDirectory: string;
  allowedDirtyPaths: string[];
};

export type ConversationManager = {
  handleMessage: (message: unknown) => Promise<void>;
  attachWebview: (webview: vscode.Webview) => vscode.Disposable;
  getState: () => ConversationManagerState;
  inspectActiveReadiness: (pipelineIds?: string[]) => Promise<RuntimeReadinessReport>;
  hasInitiative: (workingDirectory?: string) => boolean;
  pipelineRequiresInitiative: (pipelineId: string | undefined) => Promise<boolean>;
  adoptIdleConversation: (
    conversationId: string,
    preparedDraft: string,
    title: string,
    workingDirectory?: string,
  ) => Promise<boolean>;
  defineInitiative: (input: { title: string; goal: string; workingDirectory?: string }) => void;
  recordExternalEvidence: (input: {
    source: ExternalEvidenceSource;
    claim: string;
    relation: ExternalEvidenceRelation;
    target: ExternalEvidenceClaimTarget;
    authority: ExternalEvidenceAuthority;
    freshnessHorizonDays?: number;
    authoredBy?: AuthoredBy;
    workingDirectory?: string;
  }) => ExternalEvidenceRecord | undefined;
  createConversation: (options?: ConversationCreateOptions) => Promise<ConversationSummary>;
  resolvePipelineSnapshotInScope: (
    pipelineScopeRoot: string,
    pipelineId: string,
    options?: {
      requireCurrentCatalog?: boolean;
      unattended?: boolean;
      rejectChecklist?: boolean;
    },
  ) => Promise<PipelineSnapshot>;
  resolvePipelineSnapshot: (
    conversationId: string,
    pipelineId: string,
    options?: {
      requireCurrentCatalog?: boolean;
      unattended?: boolean;
      rejectChecklist?: boolean;
    },
  ) => Promise<PipelineSnapshot>;
  configurePipelineSnapshot: (
    conversationId: string,
    pipelineSnapshot: PipelineSnapshot,
  ) => Promise<void>;
  runConversation: (
    conversationId: string,
    prompt: string,
    attachmentIds?: string[],
    iterationCount?: number,
    options?: ConversationRunOptions,
  ) => Promise<ConversationExecutionResult>;
  interruptConversation: (conversationId: string) => Promise<void>;
  archiveConversation: (conversationId: string, archived: boolean) => Promise<void>;
  closeConversation: (conversationId: string) => Promise<void>;
  flush: () => Promise<void>;
  setChecklistExecutor: (
    executor: ((context: ChecklistExecutionContext) => Promise<ExecuteChecklistResult>) | undefined,
    preflight?: ((context: ChecklistPreflightContext) => Promise<void>) | undefined,
  ) => void;
  setTodoOrchestrator: (orchestrator: TodoOrchestrationControl | undefined) => void;
  setOnboardingObserver: (observer: OnboardingObserver | undefined) => void;
  dispose: () => Promise<void>;
};

export type OnboardingObserver = (event: OnboardingEvent) => void;

type RuntimeSlot = {
  runtime: Runtime;
  proxy?: vscode.Disposable;
};

type RuntimeExecutionContext = {
  iterationRef: string;
  pairRef?: string | undefined;
  stepRefs: Map<string, string>;
  roles: Record<string, string>;
  activeStepRef?: string | undefined;
  lastStepEventKey?: string | undefined;
};

type PersistedManagerState = {
  conversations: ConversationSummary[];
  activeConversationId: string;
};

// Exported so a read-only window can read the state this manager persisted without
// constructing the manager itself.
export const MANAGER_STATE_KEY = "bachata.conversationManager.v1";
const managerStorageKey = MANAGER_STATE_KEY;
const defaultConversationId = DEFAULT_CONVERSATION_ID;
const defaultRuntimeStorageKey = "bachata.runtimeState.v5";
const conversationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const conversationRuntimeStorageKey = (conversationId: string): string =>
  `bachata.conversationRuntime.v2.${conversationId}`;

const isConversationId = (value: string): boolean =>
  value === defaultConversationId || conversationIdPattern.test(value) || isReference(value, "R");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// The digest attests the bytes the bundle ships. Export-policy redaction rewrites the serialized
// bundle, so the digest is taken again over the redacted run section; without this every export
// from a repository that declares a literal is reported as changed after export and refused by
// replay. A literal that spans JSON escaping can also break the file, so it is read back first.
const resealRunBundle = (serialized: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `Bachata refused this export: redaction produced a run bundle it could not read back. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const integrity = inspectRunBundleIntegrity(parsed);
  if (integrity.state === "unrecorded" || !isRecord(parsed)) {
    throw new Error(
      "Bachata refused this export: redaction produced a run bundle it could not read back.",
    );
  }
  return `${JSON.stringify(
    { ...parsed, integrity: { algorithm: "sha256", value: integrity.computed } },
    undefined,
    2,
  )}\n`;
};

const isRuntimeLeadFallback = (
  value: unknown,
): value is RuntimeInteractionFallback =>
  isRecord(value) &&
  value.type === "lead" &&
  typeof value.originAgentId === "string" &&
  typeof value.title === "string" &&
  typeof value.prompt === "string" &&
  Array.isArray(value.options) &&
  value.options.every(
    (option) =>
      isRecord(option) &&
      typeof option.id === "string" &&
      typeof option.label === "string" &&
      (option.description === undefined || typeof option.description === "string"),
  ) &&
  typeof value.allowFreeText === "boolean";


const parseSummary = (value: unknown): ConversationSummary | undefined => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isConversationId(value.id) ||
    typeof value.title !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  const workflowStatus =
    typeof value.workflowStatus === "string" &&
    ["idle", "running", "paused", "completed", "interrupted", "error"].includes(
      value.workflowStatus,
    )
      ? (value.workflowStatus as ConversationSummary["workflowStatus"])
      : "idle";
  const restoredWorkflowStatus =
    workflowStatus === "running" || workflowStatus === "paused"
      ? "interrupted"
      : workflowStatus;
  const runRef = typeof value.runRef === "string" && isReference(value.runRef, "R")
    ? value.runRef
    : createReference("R");
  return {
    id: value.id,
    runRef,
    title: value.title.trim().slice(0, 120) || "New conversation",
    input: typeof value.input === "string" ? value.input : undefined,
    preparedDraft:
      typeof value.preparedDraft === "string" && value.preparedDraft.length <= 131_072
        ? value.preparedDraft
        : undefined,
    iterationCount:
      typeof value.iterationCount === "number" && Number.isSafeInteger(value.iterationCount)
        ? Math.max(1, Math.min(50, value.iterationCount))
        : 1,
    activeIteration:
      typeof value.activeIteration === "number" && Number.isSafeInteger(value.activeIteration)
        ? Math.max(1, value.activeIteration)
        : 1,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    running: false,
    waitingForResources: false,
    workflowStatus: restoredWorkflowStatus,
    unread:
      typeof value.unread === "number" && Number.isSafeInteger(value.unread)
        ? Math.max(0, value.unread)
        : 0,
    archived: value.archived === true,
    selectedPipelineId:
      typeof value.selectedPipelineId === "string"
        ? value.selectedPipelineId
        : undefined,
    selectedPipelineHash:
      typeof value.selectedPipelineHash === "string" && /^[0-9a-f]{64}$/u.test(value.selectedPipelineHash)
        ? value.selectedPipelineHash
        : undefined,
    pipelineScopeRoot:
      typeof value.pipelineScopeRoot === "string"
        ? value.pipelineScopeRoot
        : undefined,
    workingDirectory:
      typeof value.workingDirectory === "string"
        ? value.workingDirectory
        : undefined,
    parentConversationId:
      typeof value.parentConversationId === "string" && isConversationId(value.parentConversationId)
        ? value.parentConversationId
        : undefined,
    orchestrationRunId:
      typeof value.orchestrationRunId === "string" ? value.orchestrationRunId : undefined,
    orchestrationTaskId:
      typeof value.orchestrationTaskId === "string" ? value.orchestrationTaskId : undefined,
    orchestrationBranch:
      typeof value.orchestrationBranch === "string" ? value.orchestrationBranch : undefined,
    orchestrationBaseCommit:
      typeof value.orchestrationBaseCommit === "string"
        ? value.orchestrationBaseCommit
        : undefined,
    orchestrationPaths: Array.isArray(value.orchestrationPaths)
      ? value.orchestrationPaths.filter((item): item is string => typeof item === "string")
      : undefined,
  };
};

const parsePersistedState = (value: unknown): PersistedManagerState | undefined => {
  if (!isRecord(value) || !Array.isArray(value.conversations)) {
    return undefined;
  }
  const conversations = Array.from(
    new Map(
      value.conversations
        .map(parseSummary)
        .filter((item): item is ConversationSummary => Boolean(item))
        .map((item) => [item.id, item]),
    ).values(),
  );
  if (conversations.length === 0) {
    return undefined;
  }
  const [firstConversation] = conversations;
  const activeConversationId =
    typeof value.activeConversationId === "string" &&
    conversations.some((item) => item.id === value.activeConversationId)
      ? value.activeConversationId
      // The caller guarantees at least one conversation before this runs.
      : firstConversation?.id ?? "";
  return { conversations, activeConversationId };
};

const createSummary = (
  id: string,
  runRef: string,
  title = "New conversation",
  metadata: Pick<
    ConversationSummary,
    | "parentConversationId"
    | "orchestrationRunId"
    | "orchestrationTaskId"
    | "orchestrationBranch"
    | "orchestrationBaseCommit"
    | "orchestrationPaths"
    | "pipelineScopeRoot"
  > = {},
): ConversationSummary => {
  const now = new Date().toISOString();
  return {
    id,
    runRef,
    title,
    iterationCount: 1,
    activeIteration: 1,
    createdAt: now,
    updatedAt: now,
    running: false,
    waitingForResources: false,
    workflowStatus: "idle",
    unread: 0,
    archived: false,
    ...metadata,
  };
};



const historySearchBudgetBytes = 33_554_432;

const titleFromPrompt = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= 52) {
    return compact;
  }
  return `${compact.slice(0, 49).trimEnd()}…`;
};

const interactionOptionIds = (interaction: InteractionRecord): Set<string> =>
  new Set(
    interaction.options.flatMap((option) =>
      isRecord(option) && typeof option.id === "string" ? [option.id] : []
    ),
  );

const validateInteractionSubmission = (
  interaction: InteractionRecord,
  selected: string[],
  freeText: string,
): string[] => {
  const optionIds = interactionOptionIds(interaction);
  const normalized = Array.from(new Set(selected));
  const invalid = normalized.find((id) => !optionIds.has(id));
  if (invalid) {
    throw new Error(`Unknown option for ${interaction.interactionRef}: ${invalid}`);
  }
  const contextValue = isRecord(interaction.context) ? interaction.context : {};
  if (interaction.kind === "executionChecklist") {
    return normalized;
  }
  if (interaction.kind === "permission" || interaction.kind === "humanGate") {
    if (normalized.length !== 1) {
      throw new Error(`${interaction.kind === "permission" ? "Permission" : "Human gate"} requires one choice`);
    }
    return normalized;
  }
  if (contextValue.secret === true) {
    if (freeText.trim().length === 0) {
      throw new Error("Secret input is required");
    }
    return normalized;
  }
  if (normalized.length === 0 && !(contextValue.allowFreeText === true && freeText.trim().length > 0)) {
    throw new Error("Select an option or enter a response");
  }
  return normalized;
};

const parseManagerMessage = (
  value: unknown,
): ConversationManagerToExtensionMessage => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid conversation message");
  }
  if (
    value.type === "manager.ready" ||
    value.type === "conversation.create" ||
    value.type === "diagnostics.revealOutput" ||
    value.type === "orchestration.start" ||
    value.type === "orchestration.resume" ||
    value.type === "orchestration.stop" ||
    value.type === "orchestration.abandon"
  ) {
    return { type: value.type };
  }
  if (
    (value.type === "orchestration.patch" ||
      value.type === "orchestration.apply" ||
      value.type === "orchestration.recheck" ||
      value.type === "orchestration.diff") &&
    typeof value.runId === "string" &&
    value.runId.trim().length > 0
  ) {
    if (typeof value.conversationId !== "string" || value.conversationId.trim().length === 0) {
      throw new Error(
        `${value.type} requires the conversation whose run result is displayed; Bachata refuses to act on a run it cannot bind to a result`,
      );
    }
    const paths = Array.isArray(value.paths)
      ? value.paths.filter((candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().length > 0)
      : undefined;
    if (paths !== undefined && paths.length !== (value.paths as unknown[]).length) {
      throw new Error(`${value.type} received a path selection that is not a list of paths`);
    }
    const hunks = parsePatchHunkReferences(value.hunks);
    if (Array.isArray(value.hunks) && hunks.length !== value.hunks.length) {
      throw new Error(`${value.type} received a hunk selection Bachata cannot read`);
    }
    return {
      type: value.type,
      runId: value.runId,
      conversationId: value.conversationId,
      ...(paths === undefined || paths.length === 0 ? {} : { paths }),
      ...(hunks.length === 0 ? {} : { hunks }),
    };
  }
  if (
    (value.type === "orchestration.cleanup" || value.type === "orchestration.reveal") &&
    typeof value.runId === "string" &&
    value.runId.trim().length > 0
  ) {
    return {
      type: value.type,
      runId: value.runId,
      ...(typeof value.conversationId === "string" && value.conversationId.trim().length > 0
        ? { conversationId: value.conversationId }
        : {}),
    };
  }
  if (
    value.type === "readiness.remediate" &&
    typeof value.remediationId === "string" &&
    /^[a-z][a-zA-Z.]{0,63}$/u.test(value.remediationId)
  ) {
    return {
      type: value.type,
      remediationId: value.remediationId,
      ...(typeof value.detail === "string" ? { detail: value.detail.slice(0, 1_000) } : {}),
    };
  }
  if (value.type === "recovery.doctor" || value.type === "recovery.setup") {
    return { type: value.type };
  }
  if (
    value.type === "settings.open" &&
    typeof value.setting === "string" &&
    /^bachata\.[A-Za-z][A-Za-z0-9.]*$/u.test(value.setting)
  ) {
    return { type: value.type, setting: value.setting };
  }
  if (
    value.type === "conversation.exportBundle" &&
    typeof value.conversationId === "string"
  ) {
    const format = value.format;
    if (format !== undefined && format !== "bundle" && format !== "markdown" && format !== "sarif") {
      throw new Error("conversation.exportBundle contains an invalid format");
    }
    return {
      type: value.type,
      conversationId: value.conversationId,
      ...(format === undefined ? {} : { format }),
    };
  }
  if (
    (value.type === "conversation.select" ||
      value.type === "conversation.close" ||
      value.type === "conversation.duplicate" ||
      value.type === "conversation.openSourceControl" ||
      value.type === "conversation.viewExecution" ||
      value.type === "conversation.consumePreparedDraft") &&
    typeof value.conversationId === "string"
  ) {
    return { type: value.type, conversationId: value.conversationId };
  }
  if (
    value.type === "conversation.saveDraft" &&
    typeof value.conversationId === "string" &&
    typeof value.text === "string"
  ) {
    return {
      type: value.type,
      conversationId: value.conversationId,
      text: value.text.slice(0, 131_072),
    };
  }
  if (
    (value.type === "conversation.revealFile" || value.type === "conversation.openChanges") &&
    typeof value.conversationId === "string" &&
    typeof value.path === "string" &&
    value.path.length > 0
  ) {
    return { type: value.type, conversationId: value.conversationId, path: value.path };
  }
  if (
    value.type === "history.search" &&
    typeof value.query === "string" &&
    typeof value.requestId === "string"
  ) {
    return {
      type: value.type,
      query: value.query.slice(0, 256),
      requestId: value.requestId,
    };
  }
  if (
    value.type === "conversation.archive" &&
    typeof value.conversationId === "string" &&
    typeof value.archived === "boolean"
  ) {
    return {
      type: value.type,
      conversationId: value.conversationId,
      archived: value.archived,
    };
  }
  if (
    value.type === "conversation.rename" &&
    typeof value.conversationId === "string" &&
    typeof value.title === "string" &&
    value.title.trim().length > 0
  ) {
    return {
      type: value.type,
      conversationId: value.conversationId,
      title: value.title.trim().slice(0, 120),
    };
  }
  if (
    (value.type === "interaction.pause" || value.type === "interaction.resume") &&
    typeof value.interactionRef === "string" &&
    isReference(value.interactionRef, "Q")
  ) {
    return { type: value.type, interactionRef: value.interactionRef };
  }
  if (
    value.type === "interaction.update" &&
    typeof value.interactionRef === "string" &&
    isReference(value.interactionRef, "Q") &&
    (value.selected === undefined ||
      (Array.isArray(value.selected) && value.selected.every((item) => typeof item === "string"))) &&
    (value.freeText === undefined || typeof value.freeText === "string")
  ) {
    return {
      type: value.type,
      interactionRef: value.interactionRef,
      ...(Array.isArray(value.selected) ? { selected: value.selected as string[] } : {}),
      ...(typeof value.freeText === "string" ? { freeText: value.freeText } : {}),
    };
  }
  if (
    value.type === "interaction.submit" &&
    typeof value.interactionRef === "string" &&
    isReference(value.interactionRef, "Q") &&
    Array.isArray(value.selected) &&
    value.selected.every((item) => typeof item === "string") &&
    typeof value.freeText === "string"
  ) {
    return {
      type: value.type,
      interactionRef: value.interactionRef,
      selected: value.selected as string[],
      freeText: value.freeText,
    };
  }
  if (
    value.type === "history.openRun" &&
    typeof value.runRef === "string" &&
    value.runRef.length > 0 &&
    value.runRef.length <= 128
  ) {
    return { type: value.type, runRef: value.runRef };
  }
  if (value.type === "initiative.define") {
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const goal = typeof value.goal === "string" ? value.goal.trim() : "";
    if (title.length === 0 || goal.length === 0) {
      throw new Error("initiative.define requires a title and a goal");
    }
    const list = (candidate: unknown): string[] | undefined =>
      Array.isArray(candidate)
        ? candidate.flatMap((item) =>
            typeof item === "string" && item.trim().length > 0 ? [item.trim().slice(0, 500)] : [])
        : undefined;
    const desiredOutcome = typeof value.desiredOutcome === "string"
      ? value.desiredOutcome.trim().slice(0, 2_000)
      : undefined;
    const scope = list(value.scope);
    const constraints = list(value.constraints);
    const acceptanceCriteria = list(value.acceptanceCriteria);
    return {
      type: value.type,
      title: title.slice(0, 200),
      goal: goal.slice(0, 2_000),
      ...(desiredOutcome === undefined ? {} : { desiredOutcome }),
      ...(scope === undefined ? {} : { scope }),
      ...(constraints === undefined ? {} : { constraints }),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    };
  }
  if (value.type === "initiative.create") {
    const title = typeof value.title === "string" ? value.title.trim().slice(0, 200) : "";
    const goal = typeof value.goal === "string" ? value.goal.trim().slice(0, 4_000) : "";
    if (title.length === 0 || goal.length === 0) {
      throw new Error("initiative.create requires a title and a goal");
    }
    const lines = (source: unknown): string[] | undefined =>
      Array.isArray(source)
        ? source.flatMap((item) =>
            typeof item === "string" && item.trim().length > 0
              ? [item.trim().slice(0, 1_000)]
              : [])
        : undefined;
    const desiredOutcome = typeof value.desiredOutcome === "string"
      ? value.desiredOutcome.trim().slice(0, 4_000)
      : undefined;
    const scope = lines(value.scope);
    const constraints = lines(value.constraints);
    const acceptanceCriteria = lines(value.acceptanceCriteria);
    return {
      type: value.type,
      title,
      goal,
      ...(desiredOutcome === undefined ? {} : { desiredOutcome }),
      ...(scope === undefined ? {} : { scope }),
      ...(constraints === undefined ? {} : { constraints }),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    };
  }
  if (value.type === "initiative.switch") {
    const initiativeId = typeof value.initiativeId === "string" ? value.initiativeId.trim() : "";
    if (initiativeId.length === 0) {
      throw new Error("initiative.switch requires the initiative to switch to");
    }
    return { type: value.type, initiativeId };
  }
  if (value.type === "initiative.setStatus") {
    const initiativeId = typeof value.initiativeId === "string" ? value.initiativeId.trim() : "";
    const status = value.status;
    if (
      initiativeId.length === 0 ||
      (status !== "active" && status !== "paused" &&
        status !== "completed" && status !== "abandoned")
    ) {
      throw new Error("initiative.setStatus requires an initiative and a known status");
    }
    return { type: value.type, initiativeId, status };
  }
  if (value.type === "initiative.export") {
    const initiativeId = typeof value.initiativeId === "string" && value.initiativeId.trim().length > 0
      ? value.initiativeId.trim()
      : undefined;
    return {
      type: value.type,
      ...(initiativeId === undefined ? {} : { initiativeId }),
    };
  }
  if (value.type === "initiative.import") {
    return { type: value.type };
  }
  if (
    value.type === "initiative.setDirection" &&
    typeof value.direction === "string" &&
    value.direction.trim().length > 0
  ) {
    const rationale = typeof value.rationale === "string" && value.rationale.trim().length > 0
      ? value.rationale.trim().slice(0, 500)
      : undefined;
    const directionEvidence = Array.isArray(value.evidence)
      ? value.evidence
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 500))
        .slice(0, 100)
      : undefined;
    const supportingDecisionIds = Array.isArray(value.supportingDecisionIds)
      ? value.supportingDecisionIds
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .slice(0, 100)
      : undefined;
    return {
      type: value.type,
      direction: value.direction.trim().slice(0, 4_000),
      ...(rationale === undefined ? {} : { rationale }),
      ...(supportingDecisionIds === undefined || supportingDecisionIds.length === 0
        ? {}
        : { supportingDecisionIds }),
      ...(directionEvidence === undefined || directionEvidence.length === 0
        ? {}
        : { evidence: directionEvidence }),
    };
  }
  if (value.type === "cycle.start" || value.type === "review.startFresh") {
    const cycleType = parseCycleType(value.cycleType);
    if (value.type === "cycle.start" && cycleType === undefined) {
      throw new Error("cycle.start requires a known cycle type");
    }
    const customType = typeof value.customType === "string" && value.customType.trim().length > 0
      ? value.customType.trim().slice(0, 100)
      : undefined;
    return value.type === "cycle.start"
      ? {
          type: value.type,
          cycleType: cycleType ?? "custom",
          ...(customType === undefined ? {} : { customType }),
        }
      : { type: value.type, ...(cycleType === undefined ? {} : { cycleType }) };
  }
  if (value.type === "cycle.rebaseline") {
    return { type: value.type };
  }
  if (value.type === "finding.merge") {
    const absorbedIdentity = typeof value.absorbedIdentity === "string"
      ? value.absorbedIdentity.trim()
      : "";
    const canonicalIdentity = typeof value.canonicalIdentity === "string"
      ? value.canonicalIdentity.trim()
      : "";
    const reason = typeof value.reason === "string" ? value.reason.trim().slice(0, 2_000) : "";
    if (absorbedIdentity.length === 0 || canonicalIdentity.length === 0) {
      throw new Error("finding.merge requires the finding being merged and the one it merges into");
    }
    if (reason.length === 0) {
      throw new Error("finding.merge requires a reason recording why they are the same defect");
    }
    return { type: value.type, absorbedIdentity, canonicalIdentity, reason };
  }
  if (value.type === "direction.runNextAction") {
    return { type: value.type };
  }
  if (value.type === "notifications.markAllRead" || value.type === "notifications.clear") {
    return { type: value.type };
  }
  if (value.type === "notifications.setMode") {
    return { type: value.type, mode: notificationMode(value.mode) };
  }
  if (value.type === "notifications.open") {
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (id.length === 0) {
      throw new Error("notifications.open requires the notification id");
    }
    return { type: value.type, id };
  }
  if (value.type === "finding.startFix") {
    const identity = typeof value.identity === "string" ? value.identity.trim() : "";
    if (identity.length === 0) {
      throw new Error("finding.startFix requires the accepted finding identity");
    }
    return { type: value.type, identity };
  }
  if (value.type === "finding.unmerge") {
    const aliasIdentity = typeof value.aliasIdentity === "string" ? value.aliasIdentity.trim() : "";
    if (aliasIdentity.length === 0) {
      throw new Error("finding.unmerge requires the merged finding identity");
    }
    return { type: value.type, aliasIdentity };
  }

  if (value.type === "cycle.close") {
    const nextCycleTrigger = typeof value.nextCycleTrigger === "string" &&
      value.nextCycleTrigger.trim().length > 0
      ? value.nextCycleTrigger.trim().slice(0, 1_000)
      : undefined;
    return {
      type: value.type,
      ...(nextCycleTrigger === undefined ? {} : { nextCycleTrigger }),
    };
  }
  if (value.type === "resolution.apply") {
    const action = parseHumanResolutionAction(value.action);
    const target = value.target;
    if (
      action === undefined ||
      (target !== "finding" && target !== "decision" && target !== "artifact"
        && target !== "externalEvidence") ||
      typeof value.id !== "string" ||
      value.id.trim().length === 0
    ) {
      throw new Error("resolution.apply requires a known target, id, and action");
    }
    const reason = typeof value.reason === "string" && value.reason.trim().length > 0
      ? value.reason.trim().slice(0, 2_000)
      : undefined;
    const supersededById = typeof value.supersededById === "string" &&
      value.supersededById.trim().length > 0
      ? value.supersededById.trim()
      : undefined;
    const materialEvidenceDelta = Array.isArray(value.materialEvidenceDelta)
      ? value.materialEvidenceDelta.flatMap((item) =>
          typeof item === "string" && item.trim().length > 0 ? [item.trim().slice(0, 2_000)] : [])
      : [];
    if (action === "reopen" && reason === undefined) {
      throw new Error("Reopening requires a reason");
    }
    if (action === "reopen" && materialEvidenceDelta.length === 0) {
      throw new Error("Reopening requires at least one material evidence delta");
    }
    if (action === "supersede" && supersededById === undefined) {
      throw new Error("Superseding requires the replacement record");
    }
    if (action === "supersede" && supersededById === value.id.trim()) {
      throw new Error("A record cannot supersede itself");
    }
    return {
      type: value.type,
      target,
      id: value.id.trim(),
      action,
      ...(reason === undefined ? {} : { reason }),
      ...(supersededById === undefined ? {} : { supersededById }),
      ...(materialEvidenceDelta.length === 0 ? {} : { materialEvidenceDelta }),
    };
  }
  if (
    value.type === "conversation.runtime" &&
    typeof value.conversationId === "string" &&
    isRecord(value.message)
  ) {
    return {
      type: value.type,
      conversationId: value.conversationId,
      message: value.message as WebviewToExtensionMessage,
    };
  }
  throw new Error(`Invalid conversation message: ${value.type}`);
};

export const createConversationManager = (
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  options: ConversationManagerOptions = {},
): ConversationManager => {
  const storageRoot = (context.storageUri ?? context.globalStorageUri).fsPath;
  const assertWorkspaceLease = (): void => options.workspaceLease?.assertValid();
  const withWorkspaceMutation: WorkspaceMutationRunner = options.withWorkspaceMutation ?? (async (operation) => {
    assertWorkspaceLease();
    return operation();
  });
  const workspaceResourceKey = options.workspaceLease?.resources.find((resource) =>
    resource.key.startsWith("workspace-state-writer:")
  )?.key;
  const workspaceFenceToken = workspaceResourceKey
    ? options.workspaceLease?.fences[workspaceResourceKey]
    : undefined;
  if (options.workspaceLease && workspaceFenceToken === undefined) {
    throw new Error("Workspace ownership lease has no writer fencing token");
  }
  const catalog = createStateCatalog(storageRoot, {
    writerFence: workspaceResourceKey && workspaceFenceToken !== undefined
      ? { resourceKey: workspaceResourceKey, token: workspaceFenceToken }
      : undefined,
    assertWritable: assertWorkspaceLease,
  });
  const defaultRepositoryRoot = (): string | undefined =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  type RepositoryOwnership = { root: string; ownershipPath: string };
  const repositoryOwnerships = new Map<string, RepositoryOwnership>();
  const rememberCanonicalRepositoryRoot = (
    requested: string | undefined,
    identity: WorkingResourceIdentity,
  ): void => {
    const ownership: RepositoryOwnership = {
      root: identity.repositoryRoot ?? identity.canonicalWorkingDirectory,
      ownershipPath: identity.repositoryIdentity ?? identity.canonicalWorkingDirectory,
    };
    repositoryOwnerships.set(identity.canonicalWorkingDirectory, ownership);
    repositoryOwnerships.set(ownership.root, ownership);
    if (requested !== undefined) repositoryOwnerships.set(requested, ownership);
  };
  const repositoryOwnership = (root: string | undefined): RepositoryOwnership | undefined =>
    root === undefined
      ? undefined
      : repositoryOwnerships.get(root) ?? { root, ownershipPath: root };
  const canonicalRepositoryRoot = (root: string | undefined): string | undefined =>
    repositoryOwnership(root)?.root;
  const ensureCanonicalRepositoryRoot = async (
    root: string | undefined,
  ): Promise<string | undefined> => {
    if (root === undefined) return undefined;
    if (repositoryOwnerships.has(root)) return canonicalRepositoryRoot(root);
    try {
      rememberCanonicalRepositoryRoot(root, await resolveWorkingResourceIdentity(root));
    } catch (error) {
      output.appendLine(
        `The repository root for ${root} could not be canonicalised: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return canonicalRepositoryRoot(root);
  };
  const longitudinalFailuresByRepository = new Map<string, string[]>();
  let longitudinalFailureScope = "";
  const longitudinalFailures = (): string[] =>
    longitudinalFailuresByRepository.get(longitudinalFailureScope) ?? [];
  const reportLongitudinalFailure = (
    message: string,
    repositoryRoot?: string,
  ): void => {
    output.appendLine(message);
    const scope = repositoryRoot === undefined
      ? longitudinalFailureScope
      : repositoryIdentity(repositoryOwnership(repositoryRoot)?.ownershipPath);
    const held = longitudinalFailuresByRepository.get(scope) ?? [];
    if (held.includes(message)) return;
    held.push(message);
    if (held.length > 20) held.shift();
    longitudinalFailuresByRepository.set(scope, held);
  };
  const longitudinalServices = new Map<string, LongitudinalService>();
  const longitudinalFor = (repositoryRoot: string | undefined): LongitudinalService => {
    const ownership = repositoryOwnership(repositoryRoot);
    const key = repositoryIdentity(ownership?.ownershipPath);
    const existing = longitudinalServices.get(key);
    if (existing) return existing;
    const mainWorktreeRoot = ownership === undefined
      ? undefined
      : mainWorktreeRootFromCommonDir(ownership.ownershipPath);
    const legacyRepositoryIds = Array.from(new Set(
      [repositoryRoot, ownership?.root, ownership?.ownershipPath, mainWorktreeRoot]
        .flatMap((value) => (value === undefined
          ? []
          : [repositoryIdentity(value), ...caseFoldedRepositoryIdentities(value)]))
        .filter((value) => value !== key),
    ));
    const service = createLongitudinalService({
      store: catalog.longitudinal,
      ...(ownership === undefined ? {} : { repositoryRoot: ownership.root }),
      ...(ownership === undefined ? {} : { ownershipPath: ownership.ownershipPath }),
      ...(legacyRepositoryIds.length === 0 ? {} : { legacyRepositoryIds }),
      onAdoptionFailure: (error) => {
        reportLongitudinalFailure(
          `Bachata could not re-bind an initiative recorded under an earlier repository identity, so longitudinal changes are refused until the workspace is reopened: ${error instanceof Error ? error.message : String(error)}`,
          repositoryRoot,
        );
      },
      createId: (prefix) => createReference(prefix),
    });
    longitudinalServices.set(key, service);
    return service;
  };
  const conversationRepositoryRoot = (
    summary: Pick<ConversationSummary, "workingDirectory" | "pipelineScopeRoot">,
  ): string | undefined =>
    summary.workingDirectory ?? summary.pipelineScopeRoot ?? defaultRepositoryRoot();
  const longitudinalForConversation = (conversationId: string): LongitudinalService => {
    const summary = state.conversations.find((item) => item.id === conversationId);
    return longitudinalFor(
      summary === undefined ? defaultRepositoryRoot() : conversationRepositoryRoot(summary),
    );
  };
  const activeLongitudinal = (): LongitudinalService =>
    longitudinalForConversation(state.activeConversationId);
  const currentBaselines = new Map<string, CycleBaseline | undefined>();
  const activeRepositoryRoot = (): string | undefined => {
    const summary = state.conversations.find(
      (item) => item.id === state.activeConversationId,
    );
    return summary === undefined ? defaultRepositoryRoot() : conversationRepositoryRoot(summary);
  };
  const cachedBaseline = (repositoryRoot: string | undefined): CycleBaseline | undefined =>
    currentBaselines.get(repositoryRoot ?? "");

  const refreshBaseline = async (
    repositoryRoot: string | undefined,
  ): Promise<CycleBaseline | undefined> => {
    const key = repositoryRoot ?? "";
    try {
      const baseline = await captureCycleBaseline(repositoryRoot, new Date().toISOString());
      currentBaselines.set(key, baseline);
      return baseline;
    } catch (error) {
      reportLongitudinalFailure(
        `Bachata could not read the repository baseline for ${key || "the workspace"}: ${error instanceof Error ? error.message : String(error)}`,
        repositoryRoot,
      );
      currentBaselines.delete(key);
      return undefined;
    }
  };
  const BASELINE_REFRESH_INTERVAL_MS = 5_000;
  let baselineRefreshAt = 0;
  let baselineRefreshInFlight = false;
  const scheduleBaselineRefresh = (): void => {
    if (disposed || baselineRefreshInFlight) return;
    const elapsed = Date.now() - baselineRefreshAt;
    if (elapsed < BASELINE_REFRESH_INTERVAL_MS) return;
    const repositoryRoot = activeRepositoryRoot();
    baselineRefreshInFlight = true;
    baselineRefreshAt = Date.now();
    void (async () => {
      const before = baselineIdentity(cachedBaseline(repositoryRoot));
      const after = baselineIdentity(await refreshBaseline(repositoryRoot));
      baselineRefreshInFlight = false;
      baselineRefreshAt = Date.now();
      if (!disposed && before !== after) emitSnapshot();
    })();
  };
  const ensureActiveLongitudinal = async (): Promise<LongitudinalService> => {
    const summary = state.conversations.find(
      (item) => item.id === state.activeConversationId,
    );
    await ensureCanonicalRepositoryRoot(
      summary === undefined ? defaultRepositoryRoot() : conversationRepositoryRoot(summary),
    );
    return activeLongitudinal();
  };
  const warmCanonicalRepositoryRoots = async (): Promise<void> => {
    const roots = new Set<string>();
    const workspaceRoot = defaultRepositoryRoot();
    if (workspaceRoot !== undefined) roots.add(workspaceRoot);
    state.conversations.forEach((conversation) => {
      const root = conversationRepositoryRoot(conversation);
      if (root !== undefined) roots.add(root);
    });
    for (const root of roots) {
      await ensureCanonicalRepositoryRoot(root);
    }
  };
  const configuration = vscode.workspace.getConfiguration("bachata");
  const maximumPipelineIterations = Math.max(
    1,
    Math.min(50, configuration.get<number>("maxPipelineIterations", 10)),
  );
  const defaultPipelineIterations = Math.max(
    1,
    Math.min(
      maximumPipelineIterations,
      configuration.get<number>("defaultPipelineIterations", 1),
    ),
  );
  const legacyPersisted = parsePersistedState(
    context.workspaceState.get<unknown>(managerStorageKey),
  );

  const notifications = createNotificationCenter({
    mode: notificationMode(configuration.get<string>("notificationMode", "material")),
  });

  const terminalResults = new Map<string, RunResultCenter>();
  const latestRechecks = new Map<string, RunRecheckRecord>();

  const summaryFromCatalog = (run: RunCatalogRecord): ConversationSummary =>
    conversationSummaryFromCatalog(run, maximumPipelineIterations);

  // The settings a run executed under, kept beside the run so a resumed or replayed run reads
  // what it ran with rather than what the workspace happens to hold now. Only the runtime may
  // write here: it is the run's own effective snapshot, with authority rebuilt from live
  // settings. A snapshot that arrived from a bundle is a property of the SOURCE run and lives in
  // replaySourceSettings until the new run publishes its own.
  const runSettingsByRun = new Map<string, RunSettingsSnapshot>();
  const replaySourceSettings = new Map<string, RunSettingsSnapshot>();
  // Values a stored snapshot carried that Bachata will not apply, kept per run so the next run
  // states them instead of quietly executing on live values for those keys.
  const runSettingRejections = new Map<string, RunSettingRejection[]>();

  const summaryCatalogRecord = (
    summary: ConversationSummary,
  ): RunCatalogRecord => conversationSummaryToCatalog(summary, {
    terminalResult: terminalResults.get(summary.runRef),
    latestRecheck: latestRechecks.get(summary.runRef),
    runSettings: runSettingsByRun.get(summary.runRef),
    replaySourceSettings: replaySourceSettings.get(summary.runRef),
  });

  const persistSummaryToCatalog = (summary: ConversationSummary): void => {
    catalog.upsertRun(summaryCatalogRecord(summary));
  };

  const persistedRuns = catalog.listRuns(true);
  persistedRuns.forEach((run) => {
    if (run.runSettings) runSettingsByRun.set(run.runRef, run.runSettings);
    if (run.replaySourceSettings) replaySourceSettings.set(run.runRef, run.replaySourceSettings);
    const rejected = [
      ...(run.rejectedRunSettings ?? []),
      ...(run.rejectedReplaySourceSettings ?? []),
    ];
    if (rejected.length > 0) runSettingRejections.set(run.runRef, rejected);
    if (run.terminalResult) terminalResults.set(run.runRef, run.terminalResult);
    if (run.latestRecheck) latestRechecks.set(run.runRef, run.latestRecheck);
  });
  let conversations = normalizeConversationTree(
    persistedRuns.map(summaryFromCatalog),
  );
  if (conversations.length === 0 && legacyPersisted) {
    conversations = normalizeConversationTree(legacyPersisted.conversations);
    conversations.forEach(persistSummaryToCatalog);
  }
  if (conversations.length === 0) {
    const run = catalog.createRun({
      title: "New conversation",
      legacyConversationId: defaultConversationId,
      iterationCount: defaultPipelineIterations,
      status: "draft",
    });
    conversations = [summaryFromCatalog(run)];
  }

  const storedActiveRunRef = catalog.getActiveRunRef();
  const legacyActiveId = legacyPersisted?.activeConversationId;
  let active = conversations.find((conversation) =>
    !conversation.archived && (
      conversation.runRef === storedActiveRunRef ||
      (storedActiveRunRef === undefined && conversation.id === legacyActiveId)
    ),
  ) ?? conversations.find((conversation) => !conversation.archived);
  if (!active) {
    const run = catalog.createRun({
      title: "New conversation",
      iterationCount: defaultPipelineIterations,
      status: "draft",
    });
    active = summaryFromCatalog(run);
    conversations.push(active);
  }

  const state: ConversationManagerState = {
    conversations,
    activeConversationId: active.id,
    defaultPipelineIterations,
    maxPipelineIterations: maximumPipelineIterations,
    interactions: [],
    eventsByConversation: {},
    resultsByConversation: {},
    orchestration: emptyOrchestrationSummary(),
    direction: longitudinalFor(defaultRepositoryRoot()).summary(),
    notifications: notifications.state(),
    conversationLocators: {},
  };
  catalog.setActiveRunRef(active.runRef);

  const runtimes = new Map<string, RuntimeSlot>();
  const sharedPipelineStorageDirectory = path.join(storageRoot, "pipelines");
  let pipelineCatalogMutationQueue = Promise.resolve();
  const runPipelineCatalogMutation = async <T>(
    catalogDirectory: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    assertWorkspaceLease();
    let lease: ResourceLease | undefined;
    let result: T | undefined;
    let operationError: unknown;
    try {
      if (options.resourceBroker) {
        const identity = catalogOwnershipIdentity(
          path.resolve(catalogDirectory),
          process.platform,
        );
        lease = await options.resourceBroker.acquire({
          resources: [{
            key: resourceKey("pipeline-catalog", identity),
            kind: "physical",
          }],
          deadlineAt: Date.now() + Math.max(
            250,
            readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "pipelineCatalogOwnerTimeoutMs", 5_000),
          ),
          label: "pipeline catalog mutation",
        });
        lease.assertValid();
      }
      result = await operation();
      lease?.assertValid();
    } catch (error) {
      operationError = error;
    }

    let releaseError: unknown;
    if (lease) {
      try {
        await lease.release();
      } catch (error) {
        releaseError = error;
        try {
          await lease.quarantine("Pipeline catalog ownership release failed");
        } catch (quarantineError) {
          releaseError = new AggregateError(
            [error, quarantineError],
            "Pipeline catalog ownership could neither be released nor quarantined",
          );
        }
      }
    }
    const failure = catalogMutationFailure({ operationError, releaseError });
    if (failure !== undefined) {
      throw failure;
    }
    return result as T;
  };
  const withPipelineCatalogMutation: PipelineCatalogMutationRunner = <T>(
    catalogDirectory: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const execute = (): Promise<T> =>
      runPipelineCatalogMutation(catalogDirectory, operation);
    const link = chainSerially(pipelineCatalogMutationQueue, execute);
    pipelineCatalogMutationQueue = link.settled;
    return link.result;
  };
  const notifyPipelineCatalogChanged = async (
    change?: PipelineCatalogChange,
  ): Promise<void> => {
    const results = await Promise.allSettled(
      Array.from(runtimes.values(), (slot) => {
        const refresh = (slot.runtime as Runtime & {
          refreshPipelines?: Runtime["refreshPipelines"];
        }).refreshPipelines;
        return refresh ? refresh.call(slot.runtime, change) : Promise.resolve();
      }),
    );
    catalogRefreshFailureMessages(results).forEach((message) => {
      output.appendLine(message);
    });
  };
  const pipelineCatalogWatchers: vscode.Disposable[] = [];
  let pipelineCatalogRefreshTimer: NodeJS.Timeout | undefined;
  const schedulePipelineCatalogRefresh = (): void => {
    const schedule = catalogRefreshSchedule({
      disposed,
      refreshPending: pipelineCatalogRefreshTimer !== undefined,
    });
    if (!schedule.schedule) {
      return;
    }
    if (schedule.cancelPending && pipelineCatalogRefreshTimer) {
      clearTimeout(pipelineCatalogRefreshTimer);
    }
    pipelineCatalogRefreshTimer = setTimeout(() => {
      pipelineCatalogRefreshTimer = undefined;
      void notifyPipelineCatalogChanged().catch((error) => {
        output.appendLine(
          `Pipeline catalog watcher refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, PIPELINE_CATALOG_REFRESH_DEBOUNCE_MS);
    pipelineCatalogRefreshTimer.unref?.();
  };
  const disposePipelineCatalogWatchers = (): void => {
    pipelineCatalogWatchers.splice(0).forEach((watcher) => watcher.dispose());
  };
  const rebuildPipelineCatalogWatchers = (): void => {
    disposePipelineCatalogWatchers();
    if (
      typeof vscode.workspace.createFileSystemWatcher !== "function" ||
      typeof vscode.RelativePattern !== "function"
    ) {
      return;
    }
    const patterns = catalogWatchPatterns({
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map(
        (folder) => folder.uri.fsPath,
      ),
      sharedDirectory: sharedPipelineStorageDirectory,
    });
    patterns.forEach(({ base, glob }) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(base, glob),
      );
      watcher.onDidCreate(schedulePipelineCatalogRefresh);
      watcher.onDidChange(schedulePipelineCatalogRefresh);
      watcher.onDidDelete(schedulePipelineCatalogRefresh);
      pipelineCatalogWatchers.push(watcher);
    });
  };
  rebuildPipelineCatalogWatchers();
  const pipelineWorkspaceFolderSubscription =
    typeof vscode.workspace.onDidChangeWorkspaceFolders === "function"
      ? vscode.workspace.onDidChangeWorkspaceFolders(() => {
          rebuildPipelineCatalogWatchers();
          schedulePipelineCatalogRefresh();
        })
      : undefined;

  const runtimeProvidesPipelineSnapshot = (runtime: Runtime): boolean =>
    typeof (runtime as Runtime & {
      getSelectedPipelineSnapshot?: Runtime["getSelectedPipelineSnapshot"];
    }).getSelectedPipelineSnapshot === "function";

  const runtimePipelineSnapshot = (runtime: Runtime): PipelineSnapshot | undefined => {
    const getter = (runtime as Runtime & {
      getSelectedPipelineSnapshot?: Runtime["getSelectedPipelineSnapshot"];
    }).getSelectedPipelineSnapshot;
    const current = getter?.call(runtime);
    if (current) {
      return current;
    }
    const runtimeState = runtime.getState();
    const definition = runtimeState.selectedPipelineDefinition;
    if (!definition) {
      return undefined;
    }
    return createPipelineSnapshot(
      definition,
      runtimeState.pipelineScopeKey ?? "builtin",
      runtimeState.pipelineScopeRoot,
    );
  };
  /**
   * EX-A5-R04. What a run's evidence is judged against is fixed by the pipeline it executed, so
   * it is recorded when that pipeline is selected and read back afterwards.
   *
   * A disposed runtime is not evidence that a pipeline declared everything. Falling back to
   * `UNKNOWN_EVIDENCE_EXPECTATIONS` whenever the definition is not in hand made a read-only
   * review owe changed files, controller verification and a ruling provider it never declared,
   * and the round it produced then read as inconclusive with three gaps it could not have filled.
   */
  const executedEvidenceExpectations = new Map<string, EvidenceExpectations>();

  const rememberEvidenceExpectations = (
    runRef: string,
    definition: PipelineDefinition | undefined,
  ): void => {
    if (!definition) return;
    executedEvidenceExpectations.set(runRef, pipelineEvidenceExpectations(definition));
  };

  /**
   * EX-A5-R04. The expectations for one run, in order of authority: the pipeline the runtime is
   * still executing, the one recorded when this run started, the one persisted with its terminal
   * result, and only then the fail-closed unknown — which stays fail-closed, because a pipeline
   * nothing can name is a pipeline nothing can excuse.
   */
  const evidenceExpectationsFor = (
    runRef: string,
    runtime: Runtime | undefined,
  ): EvidenceExpectations => {
    const executing = runtime ? runtimePipelineSnapshot(runtime)?.definition : undefined;
    if (executing) {
      rememberEvidenceExpectations(runRef, executing);
      return pipelineEvidenceExpectations(executing);
    }
    return executedEvidenceExpectations.get(runRef)
      ?? terminalResults.get(runRef)?.expectations
      ?? UNKNOWN_EVIDENCE_EXPECTATIONS;
  };

  const runtimeContexts = new Map<string, RuntimeExecutionContext>();
  const chatRefs = new Map<string, string>();
  const activeRuntimeMessages = new Map<string, number>();
  const activeConversationRuns = new Set<string>();
  const activeConversationRunCompletions = new Map<string, Promise<void>>();
  const runtimeOperations = new Set<Promise<void>>();
  const pendingWorkingDirectories = new Map<string, string>();
  const webviews = new Set<vscode.Webview>();
  const interactionWaiters = new Map<
    string,
    Array<(response: RuntimeInteractionResponse) => void>
  >();
  const notifiedInteractions = new Set<string>();
  const maximumActiveConversations = Math.max(
    1,
    configuration.get<number>("maxActiveConversations", 20),
  );
  let persistQueue = Promise.resolve();
  let mutationQueue = Promise.resolve();
  let disposed = false;
  let disposeOperation: Promise<void> | undefined;
  let checklistExecutor:
    | ((context: ChecklistExecutionContext) => Promise<ExecuteChecklistResult>)
    | undefined;
  let checklistPreflight:
    | ((context: ChecklistPreflightContext) => Promise<void>)
    | undefined;
  let todoOrchestrator: TodoOrchestrationControl | undefined;
  let onboardingObserver: OnboardingObserver | undefined;
  let todoOrchestratorSubscription: { dispose: () => void } | undefined;
  let lastFocusedOrchestrationRunId: string | undefined;
  let queuedPipelineExecutor: (
    conversationId: string,
    request: {
      queueMessageId: string;
      pipelineId: string;
      pipelineSnapshot?: PipelineSnapshot | undefined;
      prompt: string;
      attachmentIds: string[];
      iterationCount: number;
      iterationMode?: "fixed" | "untilClean" | undefined;
      requiredCleanPasses?: number | undefined;
      composerAuthorized?: boolean | undefined;
    },
    onAccepted: () => Promise<void>,
  ) => Promise<void> = async () => {
    throw new Error("Queued pipeline execution is not initialized");
  };
  let queuedDirectExecutor: (
    conversationId: string,
    request: {
      queueMessageId: string;
      recipients: string[];
      prompt: string;
      mode: "review" | "implementation";
      attachmentIds: string[];
    },
    onAccepted: () => Promise<void>,
  ) => Promise<void> = async () => {
    throw new Error("Queued direct execution is not initialized");
  };


  type ExecutionLeaseUser = {
    demand: LocalAgentDemand;
    transientLease?: ResourceLease;
  };

  type ExecutionLeaseState = {
    lease: ResourceLease;
    users: Map<string, ExecutionLeaseUser>;
    // Reserved but not yet committed: these hold no share of the lease, so a conversation whose
    // committed users have all released still closes while a top-up is waiting on the broker.
    pendingUsers: Set<string>;
    reservedLocalAgents: number;
    reservedPersistentAgents: Set<string>;
    persistentLeases: ResourceLease[];
    closing?: Promise<void>;
  };

  const executionLeases = new Map<string, ExecutionLeaseState>();
  const suspendedExecutionUsers = new Map<string, { userId: string; demand: LocalAgentDemand }>();
  const executionLeaseAcquisitions = new Map<string, Promise<void>>();
  const executionLeaseControllers = new Map<string, AbortController>();
  const executionLeaseMutationQueues = new Map<string, Promise<void>>();

  const enqueueExecutionLeaseMutation = <T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = executionLeaseMutationQueues.get(conversationId) ?? Promise.resolve();
    const link = chainSerially(previous, operation);
    executionLeaseMutationQueues.set(conversationId, link.settled);
    void link.settled.finally(() => {
      if (executionLeaseMutationQueues.get(conversationId) === link.settled) {
        executionLeaseMutationQueues.delete(conversationId);
      }
    });
    return link.result;
  };

  const bounded = async <T>(
    operation: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} exceeded ${String(timeoutMs)} ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const localAdapterType = (
    slot: RuntimeSlot,
    agentId: string,
  ): "codex-app-server" | "claude-code" | undefined => {
    const adapterType = slot.runtime.getState().agents[agentId]?.adapterType;
    return adapterType === "codex-app-server" || adapterType === "claude-code"
      ? adapterType
      : undefined;
  };

  const isLocalAgent = (slot: RuntimeSlot, agentId: string): boolean =>
    localAdapterType(slot, agentId) !== undefined;

  const localAgentCount = (slot: RuntimeSlot): number =>
    Object.keys(slot.runtime.getState().agents).filter((agentId) =>
      isLocalAgent(slot, agentId)
    ).length;

  const maximumLocalAgents = (): number => Math.max(
    1,
    configuration.get<number>("maxConcurrentLocalAgents", 4),
  );

  const availabilityLocalAgentDemand = (slot: RuntimeSlot): LocalAgentDemand => {
    const transientSlots = Math.min(localAgentCount(slot), maximumLocalAgents());
    return {
      persistentAgentIds: [],
      transientSlots,
      totalUnits: transientSlots,
    };
  };

  const localRecipientDemand = (
    slot: RuntimeSlot,
    recipients: string[],
  ): LocalAgentDemand => {
    const persistentAgentIds = Array.from(new Set(recipients.filter((agentId) =>
      localAdapterType(slot, agentId) === "codex-app-server"
    )));
    const transientSlots = new Set(recipients.filter((agentId) =>
      localAdapterType(slot, agentId) === "claude-code"
    )).size;
    return {
      persistentAgentIds,
      transientSlots,
      totalUnits: persistentAgentIds.length + transientSlots,
    };
  };

  const pipelineLocalAgentDemand = (slot: RuntimeSlot): LocalAgentDemand => {
    const runtimeState = slot.runtime.getState();
    const definition = runtimeState.selectedPipelineDefinition;
    if (!definition || !Array.isArray(definition.steps)) {
      return {
        persistentAgentIds: [],
        transientSlots: 0,
        totalUnits: localAgentCount(slot),
      };
    }
    const roles = { ...runtimeState.roles };
    const persistentCodexAgents = new Set<string>();
    let maximumUnits = 0;
    for (const step of definition.steps) {
      if (!step.enabled) {
        continue;
      }
      if (step.type === "assignRoles") {
        step.roleAssignments.forEach((assignment) => {
          roles[assignment.role] = assignment.agentId;
        });
        continue;
      }
      if (step.type !== "agent" && step.type !== "checklist") {
        continue;
      }
      const resolved = Array.from(new Set(step.participants.map((participant) =>
        runtimeState.agents[participant] ? participant : roles[participant]
      ).filter((agentId): agentId is string => Boolean(agentId))));
      if (step.type === "agent" && step.parallel) {
        const claudeAgents = new Set<string>();
        resolved.forEach((agentId) => {
          const adapterType = localAdapterType(slot, agentId);
          if (adapterType === "codex-app-server") {
            persistentCodexAgents.add(agentId);
          } else if (adapterType === "claude-code") {
            claudeAgents.add(agentId);
          }
        });
        maximumUnits = Math.max(
          maximumUnits,
          persistentCodexAgents.size + claudeAgents.size,
        );
        continue;
      }
      for (const agentId of resolved) {
        const adapterType = localAdapterType(slot, agentId);
        if (adapterType === "codex-app-server") {
          persistentCodexAgents.add(agentId);
          maximumUnits = Math.max(maximumUnits, persistentCodexAgents.size);
        } else if (adapterType === "claude-code") {
          maximumUnits = Math.max(maximumUnits, persistentCodexAgents.size + 1);
        }
      }
    }
    return {
      persistentAgentIds: [],
      transientSlots: 0,
      totalUnits: maximumUnits,
    };
  };

  const observeExecutionLease = (
    lease: ResourceLease,
    slot: RuntimeSlot,
    runRef: string,
  ): void => {
    lease.signal.addEventListener("abort", () => {
      void slot.runtime.interrupt().catch((error) => {
        output.appendLine(
          `Execution lease was lost for ${runRef}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, { once: true });
  };

  const executionStateLeases = (current: ExecutionLeaseState): ResourceLease[] => {
    const byId = new Map<string, ResourceLease>();
    for (const lease of [
      current.lease,
      ...current.persistentLeases,
      ...Array.from(current.users.values(), (user) => user.transientLease),
    ]) {
      if (lease && !byId.has(lease.id)) byId.set(lease.id, lease);
    }
    return executionStateLeaseIds({
      leaseId: current.lease.id,
      persistentLeaseIds: current.persistentLeases.map((lease) => lease.id),
      transientLeaseIds: Array.from(current.users.values(), (user) => user.transientLease?.id),
    }).flatMap((id) => {
      const lease = byId.get(id);
      return lease ? [lease] : [];
    });
  };

  const releasePhysicalLease = async (
    lease: ResourceLease,
    reason: string,
  ): Promise<void> => {
    try {
      await lease.release();
    } catch (error) {
      try {
        await lease.quarantine(reason);
      } catch (quarantineError) {
        throw new AggregateError(
          [error, quarantineError],
          "A local-provider reservation could neither be released nor quarantined",
        );
      }
      throw error;
    }
  };

  const acquireSharedExecutionLease = async (
    conversationId: string,
    slot: RuntimeSlot,
    deadlineAt: number,
    resources: ResourceClaim[],
    label: string,
  ): Promise<ResourceLease> => {
    const summary = findSummary(conversationId);
    const controller = new AbortController();
    executionLeaseControllers.set(conversationId, controller);
    summary.waitingForResources = true;
    emitSnapshot();
    const acquisition = (async (): Promise<ResourceLease> => {
      if (options.resourceBroker) {
        return options.resourceBroker.acquire({
          resources,
          deadlineAt,
          signal: controller.signal,
          label,
        });
      }
      return localExecutionLease({ id: `local-${conversationId}-${randomUUID()}`, resources });
    })();
    executionLeaseAcquisitions.set(
      conversationId,
      acquisition.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      const lease = await acquisition;
      observeExecutionLease(lease, slot, summary.runRef);
      return lease;
    } finally {
      summary.waitingForResources = false;
      emitSnapshot();
      if (executionLeaseControllers.get(conversationId) === controller) {
        executionLeaseControllers.delete(conversationId);
      }
      executionLeaseAcquisitions.delete(conversationId);
    }
  };

  const closeExecutionLease = async (
    conversationId: string,
    slot: RuntimeSlot,
    current: ExecutionLeaseState,
  ): Promise<void> => {
    if (current.closing) {
      return current.closing;
    }
    const cleanupTimeoutMs = Math.max(
      1_000,
      readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "providerCleanupTimeoutMs", 15_000),
    );
    const leases = executionStateLeases(current);
    const closing = (async (): Promise<void> => {
      try {
        const shutdown = (slot.runtime as Runtime & { shutdownIdleProviders?: () => Promise<void> })
          .shutdownIdleProviders;
        if (shutdown) {
          await bounded(shutdown.call(slot.runtime), cleanupTimeoutMs, "Provider cleanup");
        }
        const releaseFailure = leaseReleaseFailure(
          rejectedReasons(await Promise.allSettled(leases.map((lease) => lease.release()))),
        );
        if (releaseFailure) {
          throw releaseFailure;
        }
      } catch (error) {
        const reason = quarantineReasonFor(error);
        const quarantines = await Promise.allSettled(leases.map((lease) => lease.quarantine(reason)));
        throw leaseQuarantineOutcome(error, rejectedReasons(quarantines));
      } finally {
        if (executionLeases.get(conversationId) === current) {
          executionLeases.delete(conversationId);
        }
      }
    })();
    current.closing = closing;
    await closing;
  };

  type ExecutionLeaseTopUp = {
    state: ExecutionLeaseState;
    demand: LocalAgentDemand;
    newPersistentAgentIds: string[];
    additionalUnits: number;
    capacity: number;
  };

  const releaseTopUpReservation = (topUp: ExecutionLeaseTopUp, userId: string): void => {
    topUp.state.pendingUsers.delete(userId);
    topUp.state.reservedLocalAgents = Math.max(
      0,
      topUp.state.reservedLocalAgents - topUp.additionalUnits,
    );
    topUp.newPersistentAgentIds.forEach((agentId) =>
      topUp.state.reservedPersistentAgents.delete(agentId));
  };

  // The broker admits requests in sequence order, so a top-up for a conversation that already
  // holds a repository slot is only admitted once that conversation releases. Waiting for it
  // inside the mutation queue would block that release behind the wait, so the reservation is
  // taken under the queue, the wait happens outside it, and the commit is synchronous.
  const retainExecutionLease = async (
    conversationId: string,
    slot: RuntimeSlot,
    deadlineAt: number,
    requestedDemand = pipelineLocalAgentDemand(slot),
    requestedUserId: string = randomUUID(),
  ): Promise<string> => {
    const topUp = await enqueueExecutionLeaseMutation(
      conversationId,
      async (): Promise<ExecutionLeaseTopUp | undefined> => {
        const demand = normalizedLocalAgentDemand(requestedDemand);
        const maxLocalAgents = maximumLocalAgents();
        const demandRefusal = localAgentDemandRefusal(demand, maxLocalAgents);
        if (demandRefusal !== undefined) {
          throw new Error(demandRefusal);
        }
        let current = executionLeases.get(conversationId);
        if (current?.closing) {
          await bounded(
            current.closing.catch(() => undefined),
            Math.max(1, deadlineAt - Date.now()),
            "Previous execution cleanup",
          );
          current = executionLeases.get(conversationId);
        }
        if (!current) {
          const summary = findSummary(conversationId);
          const workingDirectory = slot.runtime.getState().workingDirectory ?? summary.workingDirectory;
          if (!workingDirectory) {
            throw new Error("Select a working folder before launching agents");
          }
          const identity = await resolveWorkingResourceIdentity(workingDirectory);
          rememberCanonicalRepositoryRoot(workingDirectory, identity);
          rememberCanonicalRepositoryRoot(summary.workingDirectory, identity);
          const resources = executionResourceClaims({
            identity,
            managedTask: Boolean(summary.orchestrationTaskId),
            pairRunCapacity: configuration.get<number>("maxConcurrentPairRuns", 4),
            repositoryCapacity: configuration.get<number>("maxConcurrentRepositoryTasks", 4),
            demandUnits: demand.totalUnits,
            maxLocalAgents,
          });
          const lease = await acquireSharedExecutionLease(
            conversationId,
            slot,
            deadlineAt,
            resources,
            `conversation ${summary.runRef}`,
          );
          executionLeases.set(conversationId, {
            lease,
            users: new Map([[requestedUserId, { demand }]]),
            pendingUsers: new Set(),
            reservedLocalAgents: demand.totalUnits,
            reservedPersistentAgents: new Set(demand.persistentAgentIds),
            persistentLeases: [],
          });
          return undefined;
        }
        current.lease.assertValid();
        current.persistentLeases.forEach((lease) => lease.assertValid());
        Array.from(current.users.values()).forEach((user) => user.transientLease?.assertValid());
        const planned = executionTopUpPlan({
          reservedLocalAgents: current.reservedLocalAgents,
          reservedPersistentAgents: Array.from(current.reservedPersistentAgents),
          demand,
          maxLocalAgents,
          userAlreadyRetained:
            current.users.has(requestedUserId) || current.pendingUsers.has(requestedUserId),
        });
        if (planned.refusal !== undefined) {
          throw new Error(planned.refusal);
        }
        current.reservedLocalAgents = planned.topUp.aggregateDemand;
        planned.topUp.newPersistentAgentIds.forEach((agentId) =>
          current.reservedPersistentAgents.add(agentId));
        current.pendingUsers.add(requestedUserId);
        return {
          state: current,
          demand,
          newPersistentAgentIds: planned.topUp.newPersistentAgentIds,
          additionalUnits: planned.topUp.additionalUnits,
          capacity: maxLocalAgents,
        };
      },
    );
    if (!topUp) {
      return requestedUserId;
    }
    let persistentLease: ResourceLease | undefined;
    let transientLease: ResourceLease | undefined;
    const abandonReservedLeases = async (reason: string): Promise<unknown[]> => {
      const failures: unknown[] = [];
      if (transientLease) {
        await releasePhysicalLease(
          transientLease,
          `Transient local-provider ${reason}`,
        ).catch((cleanupError) => failures.push(cleanupError));
      }
      if (persistentLease) {
        await releasePhysicalLease(
          persistentLease,
          `Persistent local-provider ${reason}`,
        ).catch((cleanupError) => failures.push(cleanupError));
      }
      return failures;
    };
    try {
      if (topUp.newPersistentAgentIds.length > 0) {
        persistentLease = await acquireSharedExecutionLease(
          conversationId,
          slot,
          deadlineAt,
          [{
            key: "local-agents:global",
            units: topUp.newPersistentAgentIds.length,
            capacity: topUp.capacity,
            kind: "physical",
          }],
          `persistent local providers for ${findSummary(conversationId).runRef}`,
        );
      }
      if (topUp.demand.transientSlots > 0) {
        transientLease = await acquireSharedExecutionLease(
          conversationId,
          slot,
          deadlineAt,
          [{
            key: "local-agents:global",
            units: topUp.demand.transientSlots,
            capacity: topUp.capacity,
            kind: "physical",
          }],
          `transient local providers for ${findSummary(conversationId).runRef}`,
        );
      }
    } catch (error) {
      releaseTopUpReservation(topUp, requestedUserId);
      const cleanupFailures = await abandonReservedLeases(
        "acquisition failed before work started",
      );
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Local-provider acquisition failed and partial reservations could not be cleaned up",
        );
      }
      throw error;
    }
    if (!topUpReservationHolds({
      currentStateIsTopUpState: executionLeases.get(conversationId) === topUp.state,
      closing: topUp.state.closing !== undefined,
    })) {
      releaseTopUpReservation(topUp, requestedUserId);
      const lost = new Error(
        "This conversation released its execution lease while the local providers for this operation were still being reserved",
      );
      const cleanupFailures = await abandonReservedLeases(
        "reservation outlived the execution it was taken for",
      );
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [lost, ...cleanupFailures],
          "Local-provider reservations could not be cleaned up after the execution lease was released",
        );
      }
      throw lost;
    }
    topUp.state.pendingUsers.delete(requestedUserId);
    if (persistentLease) {
      topUp.state.persistentLeases.push(persistentLease);
    }
    topUp.state.users.set(requestedUserId, {
      demand: topUp.demand,
      ...(transientLease === undefined ? {} : { transientLease }),
    });
    return requestedUserId;
  };

  const releaseExecutionLease = (
    conversationId: string,
    slot: RuntimeSlot,
    userId: string,
  ): Promise<void> => enqueueExecutionLeaseMutation(conversationId, async () => {
    const suspended = suspendedExecutionUsers.get(conversationId);
    const current = executionLeases.get(conversationId);
    const user = current?.users.get(userId);
    const plan = executionReleasePlan({
      suspendedUserId: suspended?.userId,
      userId,
      hasLease: current !== undefined,
      isKnownUser: user !== undefined,
      remainingUsersAfterRelease: (current?.users.size ?? 1) - 1,
      hasTransientLease: user?.transientLease !== undefined,
    });
    if (plan.action === "dropSuspended") {
      suspendedExecutionUsers.delete(conversationId);
      return;
    }
    if (plan.action === "none" || !current || !user) {
      return;
    }
    current.users.delete(userId);
    const failures: unknown[] = [];
    if (plan.releaseTransient && user.transientLease) {
      await releasePhysicalLease(
        user.transientLease,
        "Transient local-provider cleanup was not confirmed",
      ).catch((error) => failures.push(error));
      current.reservedLocalAgents = Math.max(
        0,
        current.reservedLocalAgents - user.demand.transientSlots,
      );
    }
    if (plan.closeLease) {
      await closeExecutionLease(conversationId, slot, current).catch((error) => failures.push(error));
    }
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Execution resource cleanup was not fully confirmed");
    }
  });

  const acquireExecutionLease = async (
    conversationId: string,
    slot: RuntimeSlot,
    deadlineAt: number,
    requestedDemand?: LocalAgentDemand,
  ): Promise<() => Promise<void>> => {
    const userId = await retainExecutionLease(
      conversationId,
      slot,
      deadlineAt,
      requestedDemand,
    );
    return releaseOnce(async () => {
      await releaseExecutionLease(conversationId, slot, userId);
    });
  };

  const suspendExecutionLeaseForChecklist = async <T>(
    conversationId: string,
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T> => {
    await enqueueExecutionLeaseMutation(conversationId, async () => {
      const current = executionLeases.get(conversationId);
      const suspensionRefusal = checklistSuspensionRefusal({
        hasLease: current !== undefined,
        closing: current?.closing !== undefined,
        userCount: current?.users.size ?? 0,
      });
      if (suspensionRefusal !== undefined || !current) {
        throw new Error(
          suspensionRefusal ??
            "Checklist execution requires exclusive ownership of the parent execution lease",
        );
      }
      const [userId, user] = current.users.entries().next().value as [string, ExecutionLeaseUser];
      suspendedExecutionUsers.set(conversationId, {
        userId,
        demand: user.demand,
      });
      current.users.clear();
      await closeExecutionLease(conversationId, slot, current);
    });
    return operation();
  };

  const withExecutionLease = async <T>(
    conversationId: string,
    slot: RuntimeSlot,
    operation: () => Promise<T>,
    requestedDemand?: LocalAgentDemand,
  ): Promise<T> => {
    const timeoutMs = Math.max(
      1_000,
      readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "executionSlotTimeoutMs", 5 * 60_000),
    );
    const release = await acquireExecutionLease(
      conversationId,
      slot,
      Date.now() + timeoutMs,
      requestedDemand,
    );
    try {
      assertWorkspaceLease();
      const current = executionLeases.get(conversationId);
      current?.lease.assertValid();
      current?.persistentLeases.forEach((lease) => lease.assertValid());
      Array.from(current?.users.values() ?? []).forEach((user) => user.transientLease?.assertValid());
      return await operation();
    } finally {
      await release();
    }
  };

  const ensureContinuationExecutionLease = async (
    conversationId: string,
    slot: RuntimeSlot,
  ): Promise<void> => {
    const current = executionLeases.get(conversationId);
    const suspended = suspendedExecutionUsers.get(conversationId);
    const plan = continuationLeasePlan({
      hasLease: current !== undefined,
      hasSuspended: suspended !== undefined,
    });
    if ("refusal" in plan) {
      throw new Error(plan.refusal);
    }
    if (plan.action === "assertHeld" && current) {
      current.lease.assertValid();
      current.persistentLeases.forEach((lease) => lease.assertValid());
      Array.from(current.users.values()).forEach((user) => user.transientLease?.assertValid());
      return;
    }
    if (!suspended) {
      throw new Error("Execution ownership was lost before the next iteration");
    }
    const timeoutMs = Math.max(
      1_000,
      readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "executionSlotTimeoutMs", 5 * 60_000),
    );
    await retainExecutionLease(
      conversationId,
      slot,
      Date.now() + timeoutMs,
      suspended.demand,
      suspended.userId,
    );
    suspendedExecutionUsers.delete(conversationId);
  };

  const attachmentForWebview = (
    webview: vscode.Webview,
    conversationId: string,
    attachment: AttachmentMetadata,
  ): AttachmentMetadata & { previewUri?: string } => {
    if (typeof webview.asWebviewUri !== "function") {
      return attachment;
    }
    const baseDirectory = conversationStorageDirectory(storageRoot, conversationId);
    const attachmentDirectory = path.join(baseDirectory, "attachments");
    const resolved = path.resolve(baseDirectory, attachment.relativePath);
    const relative = path.relative(attachmentDirectory, resolved);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return attachment;
    }
    return {
      ...attachment,
      previewUri: webview.asWebviewUri(vscode.Uri.file(resolved)).toString(),
    };
  };

  const messageForWebview = (
    webview: vscode.Webview,
    message: ConversationManagerToWebviewMessage,
  ): ConversationManagerToWebviewMessage => {
    if (message.type !== "conversation.message") {
      return message;
    }
    if (message.message.type === "state.snapshot") {
      return {
        ...message,
        message: {
          ...message.message,
          state: {
            ...message.message.state,
            attachments: message.message.state.attachments.map((attachment) =>
              attachmentForWebview(webview, message.conversationId, attachment),
            ),
          },
        },
      };
    }
    if (message.message.type === "attachment.added") {
      return {
        ...message,
        message: {
          ...message.message,
          attachment: attachmentForWebview(
            webview,
            message.conversationId,
            message.message.attachment,
          ),
        },
      };
    }
    return message;
  };

  const post = (message: ConversationManagerToWebviewMessage): void => {
    webviews.forEach((webview) => {
      void webview.postMessage(messageForWebview(webview, message)).then(undefined, (error: unknown) => {
        output.appendLine(
          `Failed to post conversation message: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  };

  const handleWorkspaceLeaseLost = (): void => {
    executionLeaseControllers.forEach((controller) => controller.abort());
    runtimes.forEach((slot) => {
      void slot.runtime.interrupt().catch((error) => {
        output.appendLine(
          `Failed to interrupt runtime after workspace ownership was lost: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    post({
      type: "manager.error",
      message: "This Extension Host lost workspace ownership. Reload the window before continuing.",
    });
  };
  options.workspaceLease?.signal.addEventListener("abort", handleWorkspaceLeaseLost, { once: true });

  const isTerminalWorkflowStatus = (
    status: ConversationSummary["workflowStatus"],
  ): boolean => status === "completed" || status === "error" || status === "interrupted";

  let terminalResultPersistPending = false;
  const rememberTerminalResult = (runRef: string, result: RunResultCenter): void => {
    const previous = terminalResults.get(runRef);
    if (previous && JSON.stringify(previous) === JSON.stringify(result)) return;
    terminalResults.set(runRef, result);
    if (terminalResultPersistPending) return;
    terminalResultPersistPending = true;
    queueMicrotask(() => {
      terminalResultPersistPending = false;
      void persist().catch((error: unknown) => {
        output.appendLine(
          `Failed to persist run result evidence: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  };

  // A single execution appends far more than one page of events, and an `output.validated` that
  // falls outside the window silently drops its findings from the persisted result. The window
  // grows until it reaches back past the current execution's cut-off, bounded well above the
  // 5000-event retention floor.
  const eventsCoveringExecution = (runRef: string, cutoff: number) => {
    let limit = EVENT_WINDOW_START;
    let events = catalog.listEvents(runRef, limit);
    for (;;) {
      const wider = nextEventWindow({
        limit,
        returned: events.length,
        reachedCutoff: events.some((event) => event.id <= cutoff),
      });
      if (wider === undefined) return events;
      limit = wider;
      events = catalog.listEvents(runRef, limit);
    }
  };

  const refreshCatalogViews = (): void => {
    const conversationByRun = new Map(
      state.conversations.map((conversation) => [conversation.runRef, conversation.id]),
    );
    state.conversationLocators = Object.fromEntries(
      state.conversations.map((conversation) => [
        conversation.id,
        catalog.listChats(conversation.runRef).map(providerConversationLocator),
      ]),
    );
    state.interactions = catalog.listOpenInteractions().flatMap((interaction) => {
      const conversationId = conversationByRun.get(interaction.runRef);
      return conversationId ? [openInteractionView(interaction, conversationId)] : [];
    });
    state.eventsByConversation = Object.fromEntries(
      state.conversations.map((conversation) => [
        conversation.id,
        catalog.listEvents(conversation.runRef, 500).map(catalogEventView),
      ]),
    );
    // Skipped for a conversation with no run behind it; see `runWasExecuted`.
    const taskById = new Map(state.orchestration.tasks.map((task) => [task.id, task]));
    const retainedRunWorktree = state.orchestration.retainedRuns
      .find((item) => item.runId === state.orchestration.runId)?.integrationWorktree;
    state.resultsByConversation = Object.fromEntries(state.conversations.flatMap((conversation) => {
      const executionRef = catalog.latestExecutionRef(conversation.runRef);
      const currentExecutionEventId = executionEventCutoff(executionRef);
      const events = eventsCoveringExecution(conversation.runRef, currentExecutionEventId);
      const decision = latestCurrentEvent(events, "decision.published", currentExecutionEventId);
      const decisionPayload = isRecord(decision?.payload) ? decision.payload : undefined;
      const decisionCandidate = decisionPayload?.candidate;
      const decisionRisks = risksFromDecision(decisionPayload);
      const currentOutputRefs = validatedOutputRefs(events, currentExecutionEventId);
      const outputFindings = catalog.listStructuredOutputs(conversation.runRef)
        .filter((output) => currentOutputRefs.has(output.outputRef))
        .flatMap((output) => modelFindingsFromStepOutputArtifact(output.value));
      const findings = mergeModelFindings(
        outputFindings,
        modelFindingsFromDecisionArtifact(decisionPayload),
      );
      const task = conversation.orchestrationTaskId
        ? taskById.get(conversation.orchestrationTaskId)
        : undefined;
      const isOrchestrationRoot = conversation.id === state.orchestration.parentConversationId;
      const rootTasks = isOrchestrationRoot ? state.orchestration.tasks : [];
      const changedFiles = changedFilesFor({
        taskChangedFiles: task?.changedFiles,
        isOrchestrationRoot,
        rootTasks,
      });
      const contractVerification = latestCurrentEvent(
        events,
        "verification.completed",
        currentExecutionEventId,
      );
      const contractChecks = contractChecksFrom(contractVerification);
      const checks = checksFor({
        taskChecks: task?.checks,
        contractChecks,
        isOrchestrationRoot,
        rootTasks,
        finalChecks: state.orchestration.finalChecks,
      });
      const conversationRuntime = runtimes.get(conversation.id)?.runtime;
      const transcript = conversationRuntime?.getState().transcript ?? [];
      const expectations = evidenceExpectationsFor(conversation.runRef, conversationRuntime);
      const selectedDefinition = conversationRuntime?.getSelectedPipelineSnapshot?.()?.definition;

      const { retainedRunId, retainedWorktree } = retainedRunTarget({
        isOrchestrationRoot,
        conversationRunId: conversation.orchestrationRunId,
        orchestrationRunId: state.orchestration.runId,
        integrationWorktree: state.orchestration.integrationWorktree,
        retainedRunWorktree,
        taskWorktreePath: task?.worktreePath,
      });
      const boundRecheck = recheckBoundTo(
        latestRechecks.get(conversation.runRef),
        retainedRunId,
      );
      const verificationRecordedAt = task?.verifiedAt ?? contractVerification?.createdAt ?? (
        isOrchestrationRoot
          ? latestCheckStamp([
              ...rootTasks.map((item) => ({ completedAt: item.verifiedAt })),
              { completedAt: state.orchestration.finalChecksVerifiedAt },
            ])
          : undefined
      );
      const currentChecks = boundRecheck
        ? mergeRecheckedChecks(checks, boundRecheck.checks)
        : checks;
      const attribution = rulingAttribution({
        hasTask: task !== undefined,
        ruledBy: decisionPayload?.ruledBy,
        provenance: parseRulingProvenance(decisionPayload?.rulingProvenance),
        decisionPublished: decision !== undefined,
      });
      const finalRuling = finalRulingFor({
        taskSummary: task?.summary,
        decisionCandidate,
      });
      const live = projectRunResult({
        status: conversation.workflowStatus,
        transcript,
        changedFiles,
        checks: currentChecks,
        finalRuling,
        ...attribution,
        providers: (conversation.participants ?? []).map((participant) => ({
          name: participant.name,
          adapter: participant.adapter,
          ...(participant.model === undefined ? {} : { model: participant.model }),
        })),
        findings,
        unresolvedRisks: [
          ...(task?.blockers ?? []),
          ...(task?.lastError ? [task.lastError] : []),
          ...decisionRisks,
        ],
        retainedWorktree,
        ...(retainedRunId === undefined ? {} : { retainedRunId }),
        ...(executionRef === undefined ? {} : { executionRef }),
        expectations,
        ...(() => {
          const provenance = verificationProvenance({
            recheck: boundRecheck,
            checks: currentChecks,
            recordedAt: verificationRecordedAt,
          });
          return provenance === undefined ? {} : { verificationProvenance: provenance };
        })(),
      });
      const persisted = terminalResults.get(conversation.runRef);
      const projected = persisted ? mergeRunResults(persisted, live) : live;
      const ran = runWasExecuted({
        events,
        provingEventTypes: executionProvingEventTypes,
        workflowStatus: conversation.workflowStatus,
        hasPersistedResult: persisted !== undefined,
        projectionHasEvidence: runResultHasEvidence(projected),
      });
      if (isTerminalWorkflowStatus(conversation.workflowStatus) && runResultHasEvidence(projected)) {
        rememberTerminalResult(conversation.runRef, projected);
        recordLongitudinalRound(
          conversation,
          executionRef,
          projected,
          mergeDecisionSources(
            decisionSourceFromDecisionArtifact(decisionPayload),
            declaredDecisionSource(conversation, selectedDefinition, currentOutputRefs),
          ),
          planSourceFromDecisionArtifact(decisionPayload),
          declaredArtifactSources(conversation, selectedDefinition, currentOutputRefs),
        );
        recordCycleVerification(conversation, projected);
      }
      return ran ? [[conversation.id, projected] as const] : [];
    }));
  };

  const recordCycleVerification = (
    conversation: ConversationSummary,
    result: RunResultCenter,
  ): void => {
    const repositoryRoot = conversationRepositoryRoot(conversation);
    const service = longitudinalFor(repositoryRoot);
    if (service.boundInitiativeId(conversation.runRef) === undefined) return;
    const baseline = cachedBaseline(repositoryRoot);
    try {
      service.recordVerification({
        runRef: conversation.runRef,
        checks: result.checks ?? [],
        expected: result.expectations.verification === true,
        ...(baseline === undefined ? {} : { baseline }),
      });
    } catch (error) {
      reportLongitudinalFailure(
        `The verification result for ${conversation.runRef} was not bound to the current cycle: ${error instanceof Error ? error.message : String(error)}`,
        repositoryRoot,
      );
    }
  };

  const runIsScopedFix = (summary: ConversationSummary): boolean => {
    try {
      const service = longitudinalFor(conversationRepositoryRoot(summary));
      const initiativeId = service.boundInitiativeId(summary.runRef);
      if (initiativeId === undefined) return false;
      return service.isScopedFixRun(summary.runRef);
    } catch {
      return false;
    }
  };

  const recordAppliedFix = (
    conversationId: string,
    applied: { stagedFiles: readonly string[]; targetBranch: string },
  ): boolean => {
    const summary = state.conversations.find((item) => item.id === conversationId);
    if (summary === undefined) return false;
    const repositoryRoot = conversationRepositoryRoot(summary);
    try {
      const service = longitudinalFor(repositoryRoot);
      if (service.boundInitiativeId(summary.runRef) === undefined) return false;
      if (!service.isScopedFixRun(summary.runRef)) return false;
      const recorded = service.recordAppliedWork({
        runRef: summary.runRef,
        title: `Applied work · ${summary.title}`,
        stagedFiles: applied.stagedFiles,
        targetBranch: applied.targetBranch,
      });
      if (!recorded.ok) {
        reportLongitudinalFailure(
          `The applied work for ${summary.runRef} was not recorded: ${recorded.reason}`,
          repositoryRoot,
        );
        return false;
      }
      return true;
    } catch (error) {
      reportLongitudinalFailure(
        `The applied work for ${summary.runRef} was not recorded against its finding: ${error instanceof Error ? error.message : String(error)}`,
        repositoryRoot,
      );
      return false;
    }
  };

  // The intent the run's own immutable pipeline snapshot declared.
  const declaredIntentOf = (summary: ConversationSummary): LongitudinalIntent =>
    summary.longitudinalIntent
      ?? runtimes.get(summary.id)?.runtime.getSelectedPipelineSnapshot?.()
        ?.definition.longitudinalIntent
      ?? "runLocal";

  const journeyOf = (conversationId: string): { journey?: OnboardingJourney } => {
    const summary = state.conversations.find((entry) => entry.id === conversationId);
    if (!summary) return {};
    const repositoryRoot = conversationRepositoryRoot(summary);
    // The initiative this run was bound to, not whichever is active now: switching
    // initiatives must never relabel a later event from an older run.
    const initiativeId = (() => {
      try {
        const service = longitudinalFor(repositoryRoot);
        return service.runBinding(summary.runRef)?.initiativeId
          ?? service.currentInitiative()?.id;
      } catch {
        return undefined;
      }
    })();
    // An event that cannot name all three carries no journey at all, and so advances nothing.
    if (repositoryRoot === undefined || initiativeId === undefined) return {};
    return { journey: { repositoryRoot, initiativeId, runRef: summary.runRef } };
  };

  const bindConversationRun = (summary: ConversationSummary): void => {
    const repositoryRoot = conversationRepositoryRoot(summary);
    if (declaredIntentOf(summary) !== "initiativeRequired") return;
    try {
      const service = longitudinalFor(repositoryRoot);
      if (service.currentInitiative() === undefined) return;
      if (service.runBinding(summary.runRef) !== undefined) return;
      service.bindRun({ runRef: summary.runRef, freshReview: false });
    } catch (error) {
      reportLongitudinalFailure(
        `The run ${summary.runRef} was not bound to a cycle: ${error instanceof Error ? error.message : String(error)}`,
        repositoryRoot,
      );
    }
  };

  // Core decisions come from the step that declared them; a consensus ruling that declared
  // nothing stays run evidence.
  const declaredDecisionSource = (
    conversation: ConversationSummary,
    definition: PipelineDefinition | undefined,
    outputRefs: ReadonlySet<string>,
  ): DecisionSourceResult => coreDecisionSourceFrom({
    definition,
    outputs: catalog.listStructuredOutputs(conversation.runRef),
    outputRefs,
  });

  const declaredArtifactSources = (
    conversation: ConversationSummary,
    definition: PipelineDefinition | undefined,
    outputRefs: ReadonlySet<string>,
  ): DeclaredArtifactSource[] => declaredArtifactSourcesFor({
    definition,
    outputs: catalog.listStructuredOutputs(conversation.runRef),
    outputRefs,
  });

  const recordLongitudinalRound = (
    conversation: ConversationSummary,
    executionRef: string | undefined,
    result: RunResultCenter,
    decisions: DecisionSourceResult,
    plan: PlanSourceResult,
    declaredArtifacts: readonly DeclaredArtifactSource[] = [],
  ): void => {
    const service = executionRef === undefined || declaredIntentOf(conversation) !== "initiativeRequired"
      ? undefined
      : longitudinalFor(conversationRepositoryRoot(conversation));
    const recording = roundRecordingDecision({
      executionRef,
      declaredIntent: declaredIntentOf(conversation),
      hasInitiative: service?.currentInitiative() !== undefined,
      runRef: conversation.runRef,
    });
    if (!recording.record) {
      if (recording.failure !== undefined) {
        reportLongitudinalFailure(recording.failure, conversationRepositoryRoot(conversation));
      }
      return;
    }
    if (!service || executionRef === undefined) return;
    const binding = service.runBinding(conversation.runRef);
    // EX-G6-03. A review that errored or was interrupted stopped looking before it finished, so
    // it did not observe the absence of anything. Counting it as a fresh review would let it mark
    // open findings not observed, promote an applied fix to verified on its silence, and add a
    // quiet round to the saturation signal that says the cycle can close. The round is still
    // recorded — it happened, and its evidence is real — but not as an independent review, and
    // the reason travels with it.
    // EX-A5-R04. Workflow completion says the steps ran, not that anything was observed. A round
    // may resolve findings and count toward saturation only when the run's own assessment is
    // usable and the evidence its pipeline actually declares is there. An inconclusive round, or
    // one that recorded it could not inspect what it was asked to, stays visible history.
    const eligibility = roundEligibility({
      declaredFreshReview: binding?.freshReview === true,
      workflowStatus: conversation.workflowStatus,
      evidenceGaps: result.evidenceGaps,
      finalAssessment: result.finalAssessment,
    });
    const priorRounds = binding === undefined ? 0 : service.rounds(binding.cycleId).length;
    try {
      const outcome = service.recordRound(roundCandidateFrom({
        runRef: conversation.runRef,
        executionRef,
        eligibility,
        findings: result.findings,
        decisions,
        plan,
        declaredArtifacts,
      }));
      if (outcome === undefined) return;
      if (outcome.stale) return;
      for (const event of freshReviewJourneyEvents({
        freshReview: eligibility.freshReview,
        priorRounds,
      })) {
        onboardingObserver?.({ ...journeyOf(conversation.id), ...event });
      }
    } catch (error) {
      reportLongitudinalFailure(
        `The review round for ${conversation.runRef} was not recorded: ${error instanceof Error ? error.message : String(error)}`,
        conversationRepositoryRoot(conversation),
      );
    }
  };

  const emitSnapshot = (): void => {
    state.conversations.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    refreshCatalogViews();
    scheduleBaselineRefresh();
    const activeRoot = activeRepositoryRoot();
    longitudinalFailureScope = repositoryIdentity(
      repositoryOwnership(activeRoot)?.ownershipPath,
    );
    const baseline = cachedBaseline(activeRoot);
    const summary = activeLongitudinal().summary(
      baseline === undefined ? {} : { currentBaseline: baseline },
    );
    state.direction = {
      ...summary,
      validationErrors: [...summary.validationErrors, ...longitudinalFailures()],
    };
    // EX-3. What the centre is derived from is a projection in `notifications/source.ts`; what
    // stays here is the state it is projected from and when.
    notifications.publish(deriveNotifications(notificationSourceFrom({
      direction: state.direction,
      conversations: state.conversations,
      results: state.resultsByConversation,
      retainedRuns: state.orchestration.retainedRuns,
      recordedAt: new Date().toISOString(),
    })));
    state.notifications = notifications.state();
    post({ type: "manager.snapshot", state: structuredClone(state) });
  };

  const persistManagerState = (
    conversationsValue: ConversationSummary[],
    activeConversationId: string,
    deletedRunRefs: string[] = [],
  ): Promise<void> => {
    assertWorkspaceLease();
    const value: PersistedManagerState = {
      conversations: structuredClone(conversationsValue),
      activeConversationId,
    };
    const records = conversationsValue.map(summaryCatalogRecord);
    const activeRunRef = conversationsValue.find(
      (conversation) => conversation.id === activeConversationId,
    )?.runRef;
    const previousValue = context.workspaceState.get<unknown>(managerStorageKey);
    const write = (): Promise<void> => withWorkspaceMutation(async () => {
      assertWorkspaceLease();
      try {
        await context.workspaceState.update(managerStorageKey, value);
        catalog.commitRuns(records, deletedRunRefs, activeRunRef);
      } catch (error) {
        try {
          await context.workspaceState.update(managerStorageKey, previousValue);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Manager state persistence failed and workspace-state rollback was incomplete",
          );
        }
        throw error;
      }
    });
    const operation = persistQueue.then(write, write);
    persistQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const persist = (): Promise<void> =>
    persistManagerState(state.conversations, state.activeConversationId);

  const clearPreparedDraft = async (conversationId: string): Promise<void> => {
    const summary = findSummary(conversationId);
    if (summary.preparedDraft === undefined) return;
    delete summary.preparedDraft;
    await persist();
    emitSnapshot();
  };

  const resolveInteractionWaiters = (
    interactionRef: string,
    response: RuntimeInteractionResponse,
  ): void => {
    const waiters = interactionWaiters.get(interactionRef) ?? [];
    interactionWaiters.delete(interactionRef);
    if (waiters.length > 0) {
      catalog.markInteractionHandled(interactionRef);
    }
    waiters.forEach((resolve) => resolve(response));
  };

  const fallbackResponse = (interaction: InteractionRecord): RuntimeInteractionResponse => {
    const optionIds = interaction.options.flatMap((option) =>
      isRecord(option) && typeof option.id === "string" ? [option.id] : [],
    );
    if (interaction.kind === "executionChecklist") {
      return { selected: [], freeText: interaction.freeText, source: "timeout" };
    }
    const cancel = optionIds.find((id) => id === "cancel" || id === "reject");
    return {
      selected: cancel ? [cancel] : [],
      freeText: "",
      source: "timeout",
    };
  };

  const notifyInteraction = (
    summary: ConversationSummary,
    interaction: InteractionRecord,
    title?: string,
  ): void => {
    if (notifiedInteractions.has(interaction.interactionRef)) {
      return;
    }
    notifiedInteractions.add(interaction.interactionRef);
    const readableTitle = parseRunTitle(summary.title)?.title ?? summary.title;
    const message = `${readableTitle} needs input${title ? ` · ${title}` : ""}`;
    void vscode.window.showInformationMessage(message, "Open", "Pause").then(
      async (choice) => {
        if (choice === "Open") {
          options.focusInteraction?.({
            conversationId: summary.id,
            interactionRef: interaction.interactionRef,
          });
          return;
        }
        if (choice === "Pause") {
          try {
            catalog.pauseInteraction(interaction.interactionRef, "toast");
            deadlineScheduler.wake();
            emitSnapshot();
          } catch {
            return;
          }
        }
      },
      () => undefined,
    );
  };

  const requestRuntimeInteraction = async (
    conversationId: string,
    request: RuntimeInteractionRequest,
  ): Promise<RuntimeInteractionResponse> => {
    const summary = findSummary(conversationId);
    const payloadHash = interactionPayloadHash(request);
    for (const interactionRef of supersededInteractionRefs(
      catalog.listOpenInteractions(summary.runRef),
      { sourceKey: request.sourceKey, payloadHash },
    )) {
      if (catalog.resolveInteraction(interactionRef, "superseded", { selected: [], freeText: "" })) {
        resolveInteractionWaiters(interactionRef, { selected: [], freeText: "", source: "cancel" });
        catalog.markInteractionHandled(interactionRef);
      }
    }
    const interaction = catalog.createInteraction({
      runRef: summary.runRef,
      sourceKey: request.sourceKey,
      kind: request.kind,
      prompt: request.prompt,
      options: request.options,
      context: interactionContextFrom(request, payloadHash),
      timeoutMs: interactionTimeoutMs({
        requested: request.timeoutMs,
        configured: readTimeoutSetting(
          (settingKey, settingFallback) =>
            vscode.workspace.getConfiguration("bachata").get(settingKey, settingFallback),
          "interactionFallbackTimeoutMs",
          120_000,
        ),
      }),
    });
    if (request.checklistItems) {
      const plan = checklistStoragePlan({
        interactionRef: interaction.interactionRef,
        stored: catalog.listChecklistItems(interaction.interactionRef),
        requested: request.checklistItems,
      });
      if (plan.action === "refuse") {
        throw new Error(plan.message);
      }
      if (plan.action === "store") {
        catalog.replaceChecklistItems(interaction.interactionRef, plan.items);
      }
    }
    if (interaction.status === "resolved") {
      const response = responseFromResolution(interaction);
      catalog.markInteractionHandled(interaction.interactionRef);
      return response;
    }
    catalog.appendEvent({
      runRef: summary.runRef,
      type: "interaction.opened",
      status: interaction.status,
      title: request.title,
      payload: {
        interactionRef: interaction.interactionRef,
        kind: request.kind,
      },
    });
    summary.workflowStatus = "paused";
    summary.running = false;
    summary.updatedAt = new Date().toISOString();
    await persist();
    emitSnapshot();
    notifyInteraction(summary, interaction, request.title);
    deadlineScheduler.wake();
    return new Promise((resolve) => {
      const waiters = interactionWaiters.get(interaction.interactionRef) ?? [];
      waiters.push(resolve);
      interactionWaiters.set(interaction.interactionRef, waiters);
    });
  };

  const deadlineScheduler = createDeadlineScheduler(catalog, {
    onTimeout: async (interaction) => {
      const summary = state.conversations.find(
        (conversation) => conversation.runRef === interaction.runRef,
      );
      let response = fallbackResponse(interaction);
      const contextValue = isRecord(interaction.context) ? interaction.context : {};
      const fallbackValue = contextValue.fallback;
      if (
        interaction.kind === "semanticQuestion" &&
        isRuntimeLeadFallback(fallbackValue) &&
        summary
      ) {
        try {
          const slot = await ensureRuntime(summary.id, false);
          response = await slot.runtime.answerSemanticQuestionWithLead(
            fallbackValue.originAgentId,
            {
              title: fallbackValue.title,
              prompt: fallbackValue.prompt,
              options: fallbackValue.options,
              allowFreeText: fallbackValue.allowFreeText,
            },
          );
          if (response.source === "lead") {
            catalog.overrideTimedOutInteraction(
              interaction.interactionRef,
              "lead",
              { selected: response.selected, freeText: response.freeText },
            );
          }
        } catch (error) {
          output.appendLine(
            `Lead fallback failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      try {
        catalog.appendEvent({
          runRef: interaction.runRef,
          stepRef: interaction.stepRef,
          type: response.source === "lead"
            ? "interaction.answeredByLead"
            : "interaction.timeout",
          status: "completed",
          title: interaction.prompt,
          payload: { selected: response.selected, source: response.source },
        });
      } catch (error) {
        output.appendLine(
          `Could not record interaction timeout: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      resolveInteractionWaiters(interaction.interactionRef, response);
      if (summary) {
        summary.workflowStatus = "running";
        summary.running = true;
        if (state.activeConversationId !== summary.id) {
          summary.unread += 1;
        }
        summary.updatedAt = new Date().toISOString();
      }
      try {
        await persist();
      } catch (error) {
        output.appendLine(
          `Could not persist interaction timeout: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      emitSnapshot();
    },
    onError: (error) => {
      output.appendLine(
        `Interaction deadline error: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const findSummary = (conversationId: string): ConversationSummary => {
    const summary = state.conversations.find((item) => item.id === conversationId);
    if (!summary) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    return summary;
  };

  const assertRunResultOwnsRun = (conversationId: string, runId: string): void => {
    const summary = findSummary(conversationId);
    const refusal = runHandoffRefusal(state.resultsByConversation[summary.id], runId);
    if (refusal) throw new Error(refusal);
  };

  const runPatchSelection = (
    message: { paths?: string[]; hunks?: unknown },
  ): PatchSelection => {
    const paths = (message.paths ?? []).filter((value) => typeof value === "string");
    const hunks = parsePatchHunkReferences(message.hunks);
    return {
      ...(paths.length > 0 ? { paths } : {}),
      ...(hunks.length > 0 ? { hunks } : {}),
    };
  };

  const recheckStatus = (value: string): VerificationResult["status"] | undefined =>
    value === "passed" || value === "failed" || value === "timedOut" || value === "cancelled"
      ? value
      : undefined;

  const recordRetainedRecheck = async (
    conversationId: string,
    runId: string,
    results: VerificationCheckResult[],
  ): Promise<void> => {
    const summary = findSummary(conversationId);
    const checks = results.flatMap((result) => {
      const status = recheckStatus(result.status);
      return status === undefined ? [] : [{
        command: result.command,
        status,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.workingDirectory === undefined ? {} : { workingDirectory: result.workingDirectory }),
        ...(result.candidateTree === undefined ? {} : { candidateTree: result.candidateTree }),
        ...(result.outputReference === undefined ? {} : { outputReference: result.outputReference }),
      }];
    });
    if (checks.length === 0) return;
    const previous = latestRechecks.get(summary.runRef);
    latestRechecks.set(summary.runRef, {
      runId,
      recordedAt: new Date().toISOString(),
      checks,
    });
    try {
      await persist();
    } catch (error) {
      if (previous) latestRechecks.set(summary.runRef, previous);
      else latestRechecks.delete(summary.runRef);
      throw error;
    }
    emitSnapshot();
  };

  const assertInteractionWritable = (interactionRef: string): InteractionRecord => {
    const interaction = catalog.getInteraction(interactionRef);
    if (!interaction) {
      throw new Error(`Unknown interaction: ${interactionRef}`);
    }
    const summary = state.conversations.find((item) => item.runRef === interaction.runRef);
    if (summary?.archived) {
      throw new Error("Archived conversations are read-only");
    }
    return interaction;
  };

  const runParticipants = (
    panel: PanelState,
  ): RunParticipant[] | undefined => {
    const agents = panel.selectedPipelineDefinition?.agents;
    if (!agents || agents.length === 0) {
      return undefined;
    }
    return agents.map((agent) => ({
      name: agent.name,
      adapter: agent.adapter,
      ...(agent.model ? { model: agent.model } : {}),
    }));
  };

  const updateSummaryFromRuntime = (
    conversationId: string,
    message: ExtensionToWebviewMessage,
  ): void => {
    const summary = state.conversations.find((item) => item.id === conversationId);
    if (!summary) {
      return;
    }
    let changed = false;
    if (message.type === "state.snapshot") {
      summary.running = message.state.running;
      summary.workflowStatus = message.state.workflowStatus;
      setOptionalProperty(summary, "selectedPipelineId", message.state.selectedPipelineId);
      setOptionalProperty(summary, "selectedPipelineHash", message.state.selectedPipelineHash);
      setOptionalProperty(summary, "pipelineScopeRoot", message.state.pipelineScopeRoot);
      setOptionalProperty(summary, "workingDirectory", message.state.workingDirectory);
      summary.participants = runParticipants(message.state) ?? summary.participants;
      changed = true;
    } else if (message.type === "run.patch") {
      const wasPaused = summary.workflowStatus === "paused";
      summary.running = message.running;
      summary.workflowStatus = message.workflowStatus;
      if (
        state.activeConversationId !== conversationId &&
        message.workflowStatus === "paused" &&
        !wasPaused
      ) {
        summary.unread += 1;
      }
      changed = true;
    } else if (message.type === "agent.patch") {
      const runtimeState = runtimes.get(conversationId)?.runtime.getState();
      if (runtimeState) {
        summary.running =
          runtimeState.running ||
          Object.values(runtimeState.agents).some(
            (agent) => agent.status === "running",
          );
        changed = true;
      }
    } else if (message.type === "error") {
      const runtimeState = runtimes.get(conversationId)?.runtime.getState();
      if (runtimeState) {
        summary.running =
          runtimeState.running ||
          Object.values(runtimeState.agents).some(
            (agent) => agent.status === "running",
          );
        summary.workflowStatus = runtimeState.workflowStatus;
      }
      if (state.activeConversationId !== conversationId) {
        summary.unread += 1;
      }
      changed = true;
    } else if (message.type === "transcript.append") {
      if (
        (summary.title === "New conversation" ||
          parseRunTitle(summary.title)?.title === "New run") &&
        message.entry.kind === "prompt" &&
        message.entry.eventType === "user.message"
      ) {
        summary.title = formatRunTitle(
          summary.runRef,
          titleFromPrompt(message.entry.text),
        );
      }
      if (state.activeConversationId !== conversationId) {
        summary.unread += 1;
      }
      changed = true;
    } else if (message.type === "approval.add") {
      if (state.activeConversationId !== conversationId) {
        summary.unread += 1;
      }
      changed = true;
    }
    if (changed) {
      summary.updatedAt = new Date().toISOString();
      void persist().catch((error) => {
        output.appendLine(
          `Failed to persist conversation state: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      emitSnapshot();
    }
  };

  const attachProxy = (conversationId: string, slot: RuntimeSlot): void => {
    if (slot.proxy || webviews.size === 0) {
      return;
    }
    slot.proxy = slot.runtime.attachWebview({
      postMessage: async (message) => {
        updateSummaryFromRuntime(conversationId, message);
        post({ type: "conversation.message", conversationId, message });
        return true;
      },
    });
  };

  const detachProxies = (): void => {
    runtimes.forEach((slot) => {
      slot.proxy?.dispose();
      delete slot.proxy;
    });
  };

  let browserBridgeLease: ResourceLease | undefined;
  let browserBridgeStartOperation: Promise<void> | undefined;

  const sharedBridge = createBrowserBridgeServer({
    enabled: vscode.env.remoteName === undefined,
    secretStore: context.secrets,
    log: (message) => output.appendLine(message),
    maxMessageBytes: vscode.workspace
      .getConfiguration("bachata")
      .get<number>("browserBridgeMaxMessageBytes", DEFAULT_BROWSER_BRIDGE_MAX_MESSAGE_BYTES),
    port: vscode.workspace
      .getConfiguration("bachata")
      .get<number>("browserBridgePort", 43127),
    localModelConfig: () => {
      const current = vscode.workspace.getConfiguration("bachata");
      const endpoint = current.get<string>("browserSelectorHealingEndpoint", "").trim();
      return {
        enabled: current.get<boolean>("browserSelectorHealingEnabled", false),
        backend: current.get<"auto" | "lmstudio" | "ollama">("browserSelectorHealingBackend", "auto"),
        ...(endpoint ? { endpoint } : {}),
        model: current.get<string>("browserSelectorHealingModel", "prism-ml/Bonsai-27B-mlx-1bit").trim() || "prism-ml/Bonsai-27B-mlx-1bit",
        timeoutMs: Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => current.get(settingKey, settingFallback), "browserSelectorHealingTimeoutMs", 30_000)),
      };
    },
    originOverrideForTests:
      process.env.BACHATA_HUMAN_E2E === "1" &&
      context.extensionMode === vscode.ExtensionMode.Development
        ? "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        : undefined,
    onStatusChange: (_status: BrowserBridgeStatus) => undefined,
  });
  const selectorHealingConfigurationKeys = [
    "bachata.browserSelectorHealingEnabled",
    "bachata.browserSelectorHealingBackend",
    "bachata.browserSelectorHealingEndpoint",
    "bachata.browserSelectorHealingModel",
    "bachata.browserSelectorHealingTimeoutMs",
  ];
  const browserSelectorHealingConfigurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!selectorHealingConfigurationKeys.some((key) => event.affectsConfiguration(key))) return;
    try {
      sharedBridge.refreshLocalModelConfig();
    } catch (error) {
      output.appendLine(`Failed to refresh Browser Bridge selector-healing configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const ensureBrowserBridgeOwnership = async (): Promise<void> => {
    if (vscode.env.remoteName !== undefined) {
      throw new Error("Browser Bridge is available only in a local VS Code window");
    }
    if (browserBridgeStartOperation) {
      return browserBridgeStartOperation;
    }
    const operation = (async (): Promise<void> => {
      let acquiredLease: ResourceLease | undefined;
      try {
        if (options.resourceBroker && !browserBridgeLease) {
          acquiredLease = await options.resourceBroker.acquire({
            resources: [{ key: "browser-bridge:profile", kind: "physical" }],
            deadlineAt: Date.now() + Math.max(
              250,
              readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "browserBridgeOwnerTimeoutMs", 2_000),
            ),
            label: "Browser Bridge ownership",
          });
          browserBridgeLease = acquiredLease;
          acquiredLease.signal.addEventListener("abort", () => {
            if (browserBridgeLease === acquiredLease) {
              browserBridgeLease = undefined;
            }
            void sharedBridge.close().catch((closeError) => {
              output.appendLine(
                `Failed to close Browser Bridge after ownership was lost: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
              );
            });
          }, { once: true });
        }
        await sharedBridge.start();
      } catch (error) {
        if (acquiredLease) {
          try {
            await bounded(
              sharedBridge.close(),
              Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "browserBridgeCloseTimeoutMs", 10_000)),
              "Browser Bridge startup cleanup",
            );
            await acquiredLease.release();
          } catch (cleanupError) {
            try {
              await acquiredLease.quarantine(
                `Browser Bridge startup cleanup was not confirmed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              );
            } catch (quarantineError) {
              throw new AggregateError(
                [error, cleanupError, quarantineError],
                "Browser Bridge startup, cleanup, and quarantine all failed",
              );
            } finally {
              if (browserBridgeLease === acquiredLease) {
                browserBridgeLease = undefined;
              }
            }
            throw new AggregateError(
              [error, cleanupError],
              "Browser Bridge startup failed and cleanup was not confirmed",
            );
          }
          if (browserBridgeLease === acquiredLease) {
            browserBridgeLease = undefined;
          }
        }
        throw error;
      }
    })();
    browserBridgeStartOperation = operation;
    try {
      await operation;
    } finally {
      if (browserBridgeStartOperation === operation) {
        browserBridgeStartOperation = undefined;
      }
    }
  };

  const runtimeStorage = (
    conversationId: string,
  ): { storageKey: string; storageDirectory: string; legacyStorageKeys: string[] } =>
    conversationId === defaultConversationId
      ? {
          storageKey: defaultRuntimeStorageKey,
          storageDirectory: storageRoot,
          // PAIR-ID-01. Both spellings: see `defaultLegacyStorageKeys` in `runtime/createRuntime`.
          // A released build wrote `pair.runtimeState.v4`, and a list that names only the current
          // spelling is a list of keys nothing ever wrote.
          legacyStorageKeys: [
            "bachata.runtimeState.v4",
            "pair.runtimeState.v4",
            "bachata.runtimeState.v3",
            "pair.runtimeState.v3",
            "llmPipeline.runtimeState.v2",
            "bachata.runtimeState.v2",
            "pair.runtimeState.v2",
          ],
        }
      : {
          storageKey: conversationRuntimeStorageKey(conversationId),
          storageDirectory: conversationStorageDirectory(storageRoot, conversationId),
          legacyStorageKeys: [
            `bachata.conversationRuntime.v1.${conversationId}`,
            `pair.conversationRuntime.v1.${conversationId}`,
          ],
        };

  const deletionTrashRoot = path.join(
    storageRoot,
    ".trash",
    "conversation-deletions",
  );

  const pathExists = async (value: string): Promise<boolean> =>
    lstat(value).then(() => true, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    });

  const isRuntimeStorageKey = (value: string): boolean =>
    value === defaultRuntimeStorageKey ||
    (
      value.startsWith("bachata.conversationRuntime.v2.") &&
      isConversationId(value.slice("bachata.conversationRuntime.v2.".length))
    );

  const parseDeletionManifest = (
    value: unknown,
    directory: string,
  ): ConversationDeletionManifest | undefined =>
    parseManifest(value, {
      storageRoot,
      trashRoot: deletionTrashRoot,
      stagedRoot: path.join(directory, "data"),
      isRuntimeStorageKey,
      isRunReference: (runRef) => isReference(runRef, "R"),
    });

  const restoreStagedConversationDeletion = async (
    staged: StagedConversationDeletion,
  ): Promise<void> => {
    await withWorkspaceMutation(async () => {
      const entriesToRestore = await plannedRestoreEntries(staged.manifest, pathExists);
      for (const entry of entriesToRestore) {
        await mkdir(path.dirname(entry.original), { recursive: true });
        await rename(entry.staged, entry.original);
      }
      for (const runtimeValue of staged.manifest.runtimeValues) {
        await context.workspaceState.update(
          runtimeValue.storageKey,
          runtimeValue.present ? runtimeValue.value : undefined,
        );
      }
      await rm(staged.directory, { recursive: true, force: true });
    });
  };

  const stageConversationDeletion = async (
    summaries: ConversationSummary[],
  ): Promise<StagedConversationDeletion> => {
    const directory = path.join(deletionTrashRoot, randomUUID());
    // EX-A5-R15. The same owned-path list retention cleanup reads, so a conversation cannot be
    // fully deleted by one set of paths and partly retained by another.
    const candidates = summaries.flatMap((summary) => conversationOwnedPaths(storageRoot, summary.id));
    const entries: Array<{ original: string; staged: string }> = [];
    for (const original of candidates) {
      if (!(await pathExists(original))) {
        continue;
      }
      entries.push({
        original,
        staged: path.join(directory, "data", String(entries.length)),
      });
    }
    const runtimeValues = summaries.map((summary) => {
      const storageKey = runtimeStorage(summary.id).storageKey;
      const value = context.workspaceState.get<unknown>(storageKey);
      return {
        storageKey,
        present: value !== undefined,
        ...(value !== undefined ? { value } : {}),
      };
    });
    const manifest: ConversationDeletionManifest = {
      version: 1,
      runRefs: summaries.map((summary) => summary.runRef),
      entries,
      runtimeValues,
    };
    const staged = { directory, manifest };
    try {
      await withWorkspaceMutation(async () => {
        await mkdir(directory, { recursive: true });
        const temporaryManifest = path.join(directory, "manifest.json.tmp");
        const manifestPath = path.join(directory, "manifest.json");
        await writeFile(temporaryManifest, `${JSON.stringify(manifest)}\n`, "utf8");
        await rename(temporaryManifest, manifestPath);
        for (const entry of entries) {
          await mkdir(path.dirname(entry.staged), { recursive: true });
          await rename(entry.original, entry.staged);
        }
        for (const runtimeValue of runtimeValues) {
          await context.workspaceState.update(runtimeValue.storageKey, undefined);
        }
      });
      return staged;
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      await restoreStagedConversationDeletion(staged).catch((rollbackError) => {
        rollbackFailures.push(rollbackError);
      });
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          "Run storage staging failed and rollback was incomplete",
        );
      }
      throw error;
    }
  };

  const reconcileStagedConversationDeletions = async (): Promise<void> => {
    const entries = await readdir(deletionTrashRoot, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      },
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = path.join(deletionTrashRoot, entry.name);
      const manifest = await readFile(path.join(directory, "manifest.json"), "utf8")
        .then((content) => parseDeletionManifest(JSON.parse(content) as unknown, directory))
        .catch(() => undefined);
      if (!manifest) {
        output.appendLine(`Ignored invalid conversation deletion manifest in ${directory}`);
        continue;
      }
      if (
        stagedDeletionDisposition(manifest, (runRef) => Boolean(catalog.getRun(runRef)))
          === "restore"
      ) {
        await restoreStagedConversationDeletion({ directory, manifest });
      } else {
        await withWorkspaceMutation(() =>
          rm(directory, { recursive: true, force: true })
        );
      }
    }
  };

  const persistedBrowserBindings = (
    conversationId: string,
  ): Array<{ agentId: string; binding: BrowserConversationBinding }> => {
    const value = context.workspaceState.get<unknown>(
      runtimeStorage(conversationId).storageKey,
    );
    if (!isRecord(value) || !isRecord(value.agents)) {
      return [];
    }
    return Object.entries(value.agents).flatMap(([agentId, agentValue]) => {
      if (!isRecord(agentValue) || !isRecord(agentValue.browserBinding)) {
        return [];
      }
      const binding = agentValue.browserBinding;
      if (
        (binding.provider !== "chatgpt" && binding.provider !== "claude" && binding.provider !== "generic") ||
        typeof binding.conversationUrl !== "string" ||
        !binding.conversationUrl ||
        typeof binding.conversationIdentity !== "string" ||
        !binding.conversationIdentity ||
        (binding.preferredTabId !== undefined &&
          !Number.isInteger(binding.preferredTabId))
      ) {
        return [];
      }
      return [{
        agentId,
        binding: {
          provider: binding.provider,
          conversationUrl: binding.conversationUrl,
          conversationIdentity: binding.conversationIdentity,
          ...(binding.preferredTabId === undefined
            ? {}
            : { preferredTabId: Number(binding.preferredTabId) }),
        },
      }];
    });
  };

  const claimPersistedBrowserBindings = (conversationId: string): void => {
    persistedBrowserBindings(conversationId).forEach(({ agentId, binding }) => {
      try {
        sharedBridge.bindConversation(`${conversationId}:${agentId}`, binding);
      } catch (error) {
        output.appendLine(
          `Could not reserve browser conversation for ${conversationId}/${agentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };

  const releaseBrowserBindings = (conversationId: string): void => {
    const runtimeState = runtimes.get(conversationId)?.runtime.getState();
    const agentIds = new Set([
      ...persistedBrowserBindings(conversationId).map(({ agentId }) => agentId),
      ...Object.keys(runtimeState?.agents ?? {}),
    ]);
    agentIds.forEach((agentId) =>
      sharedBridge.releaseBinding(`${conversationId}:${agentId}`),
    );
  };

  const roleForAgent = (
    contextValue: RuntimeExecutionContext,
    agentId: string,
  ): string =>
    Object.entries(contextValue.roles).find(([, assignedAgentId]) =>
      assignedAgentId === agentId
    )?.[0] ?? agentId;

  const syncAgentChat = (
    conversationId: string,
    agentId: string,
    agent: AgentPanelState,
  ): void => {
    const summary = state.conversations.find((item) => item.id === conversationId);
    const execution = runtimeContexts.get(conversationId);
    if (!summary || !execution) {
      return;
    }
    const chatKey = `${summary.runRef}:${execution.iterationRef}:${agentId}`;
    const role = roleForAgent(execution, agentId);
    const readableRunTitle = parseRunTitle(summary.title)?.title ?? summary.title;
    let chatRef = chatRefs.get(chatKey);
    let existing = chatRef
      ? catalog.listChats(summary.runRef).find((chat) => chat.chatRef === chatRef)
      : catalog.listChats(summary.runRef).find((chat) =>
          chat.iterationRef === execution.iterationRef && chat.agentId === agentId
        );
    if (!existing) {
      existing = catalog.createChat({
        runRef: summary.runRef,
        iterationRef: execution.iterationRef,
        pairRef: execution.pairRef,
        agentId,
        role,
        provider: agent.browserBinding?.provider ?? agent.adapterType,
        adapter: agent.adapterType,
        providerSessionId: agent.sessionId,
        providerConversationUrl: agent.browserBinding?.conversationUrl,
        providerConversationIdentity: agent.browserBinding?.conversationIdentity,
        displayTitle: "",
        status: agent.status,
      });
      existing.displayTitle = formatProviderChatTitle(
        summary.runRef,
        existing.chatRef,
        role,
        readableRunTitle,
      );
    }
    chatRef = existing.chatRef;
    chatRefs.set(chatKey, chatRef);
    catalog.upsertChat({
      ...existing,
      pairRef: execution.pairRef,
      agentId,
      role,
      provider: agent.browserBinding?.provider ?? agent.adapterType,
      adapter: agent.adapterType,
      providerSessionId: agent.sessionId,
      providerConversationUrl: agent.browserBinding?.conversationUrl,
      providerConversationIdentity: agent.browserBinding?.conversationIdentity,
      displayTitle: formatProviderChatTitle(
        summary.runRef,
        chatRef,
        role,
        readableRunTitle,
      ),
      status: agent.status,
      updatedAt: new Date().toISOString(),
    });
  };

  const beginPipelineStep = (
    conversationId: string,
    event: { step: PipelineStep; index: number; round?: number | undefined },
  ): void => {
    const summary = state.conversations.find((item) => item.id === conversationId);
    const execution = runtimeContexts.get(conversationId);
    if (!summary || !execution) {
      return;
    }
    // The runtime publishes the snapshot the run is actually executing under, with authority and
    // recorded-only values taken from live settings. It replaces whatever is held, so an earlier
    // reading can never outlive it and a replay's source can never stand in for it.
    const effective = runtimes.get(conversationId)?.runtime.getState()
      .executionContract?.provenance.runSettings;
    if (
      effective
      && runSettingsFingerprint(effective)
        !== (held => held && runSettingsFingerprint(held))(runSettingsByRun.get(summary.runRef))
    ) {
      runSettingsByRun.set(summary.runRef, effective);
      persistSummaryToCatalog(summary);
    }
    const eventKey = `${event.step.id}:${String(event.round ?? 0)}`;
    let stepRef = execution.stepRefs.get(event.step.id);
    if (!stepRef) {
      stepRef = catalog.ensureStep({
        runRef: summary.runRef,
        iterationRef: execution.iterationRef,
        pipelineStepId: event.step.id,
        name: event.step.name,
        index: event.index,
        status: "running",
      });
      execution.stepRefs.set(event.step.id, stepRef);
    }
    if (execution.activeStepRef && execution.activeStepRef !== stepRef) {
      catalog.updateStep(execution.activeStepRef, {
        status: "completed",
        completed: true,
      });
    }
    execution.activeStepRef = stepRef;
    catalog.updateStep(stepRef, { status: "running", started: true });
    if (execution.lastStepEventKey !== eventKey) {
      execution.lastStepEventKey = eventKey;
      catalog.appendEvent({
        runRef: summary.runRef,
        iterationRef: execution.iterationRef,
        pairRef: execution.pairRef,
        stepRef,
        type: event.round === undefined ? "step.started" : "step.round.started",
        status: "running",
        title: event.step.name,
        payload: event.round === undefined ? undefined : { round: event.round },
      });
      emitSnapshot();
    }
  };

  const savePipelineOutput = (
    conversationId: string,
    artifact: StepOutputArtifact,
  ): void => {
    const summary = state.conversations.find((item) => item.id === conversationId);
    const execution = runtimeContexts.get(conversationId);
    if (!summary || !execution) {
      return;
    }
    const stepRef = execution.stepRefs.get(artifact.stepId);
    const outputRef = catalog.saveStructuredOutput({
      runRef: summary.runRef,
      iterationRef: execution.iterationRef,
      stepRef,
      name: `${artifact.name}.${artifact.agentId}`,
      contentHash: artifact.hash,
      value: artifact,
    });
    catalog.appendEvent({
      runRef: summary.runRef,
      iterationRef: execution.iterationRef,
      pairRef: execution.pairRef,
      stepRef,
      type: artifact.validationErrors.length === 0
        ? "output.validated"
        : "output.invalid",
      status: artifact.validationErrors.length === 0 ? "completed" : "failed",
      title: artifact.name,
      payload: {
        outputRef,
        agentId: artifact.agentId,
        hash: artifact.hash,
        validationErrors: artifact.validationErrors,
      },
    });
    emitSnapshot();
  };

  const savePipelineDecision = (
    conversationId: string,
    artifact: DecisionArtifact,
  ): void => {
    const summary = state.conversations.find((item) => item.id === conversationId);
    const execution = runtimeContexts.get(conversationId);
    if (!summary || !execution) {
      return;
    }
    const stepRef = execution.stepRefs.get(artifact.stepId);
    catalog.saveStructuredOutput({
      runRef: summary.runRef,
      iterationRef: execution.iterationRef,
      stepRef,
      name: `decision.${artifact.stepId}.${String(artifact.round)}`,
      contentHash: artifact.candidateHash ?? "none",
      value: artifact,
    });
    catalog.appendEvent({
      runRef: summary.runRef,
      iterationRef: execution.iterationRef,
      pairRef: execution.pairRef,
      stepRef,
      type: "decision.published",
      status: artifact.status,
      title: artifact.candidateId ?? artifact.stepId,
      payload: {
        stepId: artifact.stepId,
        round: artifact.round,
        policy: artifact.policy,
        status: artifact.status,
        candidateId: artifact.candidateId,
        candidateHash: artifact.candidateHash,
        candidate: artifact.candidate,
        participants: artifact.participants.map((participant) => ({
          agentId: participant.agentId,
          valid: participant.valid,
          accepted: participant.accepted,
          candidateHash: participant.candidateHash,
          validationErrors: participant.validationErrors,
        })),
        objections: artifact.objections,
        unresolvedRisks: artifact.unresolvedRisks,
        ruledBy: artifact.ruledBy,
        rulingProvenance: artifact.rulingProvenance,
      },
    });
    emitSnapshot();
  };

  const ensureRuntime = async (
    conversationId: string,
    attach = true,
    preparedSummary?: ConversationSummary,
  ): Promise<RuntimeSlot> => {
    const existing = runtimes.get(conversationId);
    if (existing) {
      if (attach) {
        attachProxy(conversationId, existing);
      }
      return existing;
    }
    if (disposed) {
      throw new Error("Bachata conversation manager is disposed");
    }
    const summaryValue = preparedSummary ?? findSummary(conversationId);
    const runtimeOptions = runtimeStorage(conversationId);
    const runtime = createRuntime(context, output, {
      ...runtimeOptions,
      ...conversationRuntimeShape({
        conversationId,
        sharedPipelineStorageDirectory,
        storageRoot,
        pipelineScopeRoot: summaryValue.pipelineScopeRoot,
        orchestrationTaskId: summaryValue.orchestrationTaskId,
        replaySettings: replaySourceSettings.get(summaryValue.runRef),
        runSettings: runSettingsByRun.get(summaryValue.runRef),
        rejectedRunSettings: runSettingRejections.get(summaryValue.runRef),
      }),
      withPipelineCatalogMutation,
      onPipelineCatalogChanged: notifyPipelineCatalogChanged,
      bridge: sharedBridge,
      assertWritable: assertWorkspaceLease,
      withWorkspaceMutation,
      requestInteraction: (request) =>
        requestRuntimeInteraction(conversationId, request),
      getProviderChatTitle: (agentId) => {
        const summary = findSummary(conversationId);
        const execution = runtimeContexts.get(conversationId);
        if (!execution) {
          return undefined;
        }
        return catalog.listChats(summary.runRef).find(
          (chat) =>
            chat.iterationRef === execution.iterationRef &&
            chat.agentId === agentId,
        )?.displayTitle;
      },
      // The repository states what it provides; Bachata compares that with what the workflow
      // declared. Nothing here asks a provider what it has installed.
      observeResourceDependencies: async (dependencies) => {
        const summary = state.conversations.find((entry) => entry.id === conversationId);
        const root = summary === undefined ? undefined : conversationRepositoryRoot(summary);
        const load = root === undefined
          ? ({ status: "absent" } as const)
          : await loadResourceRegistry(root, (candidate) => readFile(candidate, "utf8"));
        return resourceAvailabilityForLoad(load, dependencies);
      },
      preflightChecklistExecution: async ({ workingDirectory, allowedDirtyPaths }) => {
        const summary = findSummary(conversationId);
        const preflight = checklistPreflight;
        const preflightRefusal = checklistExecutionRefusal({
          orchestrationTaskId: summary.orchestrationTaskId,
          hasHost: preflight !== undefined,
          hostAbsence: CHECKLIST_PREFLIGHT_UNAVAILABLE,
          requiresWorkingDirectory: false,
          hasActiveRuntime: true,
          requiresActiveRuntime: false,
        });
        if (preflightRefusal !== undefined || !preflight) {
          throw new Error(preflightRefusal ?? CHECKLIST_PREFLIGHT_UNAVAILABLE);
        }
        await preflight({
          conversationId,
          runRef: summary.runRef,
          title: parseRunTitle(summary.title)?.title ?? summary.title,
          workingDirectory,
          allowedDirtyPaths,
        });
      },
      executeChecklist: async (request) => {
        const summary = findSummary(conversationId);
        const workingDirectory = runtimes.get(conversationId)?.runtime.getState().workingDirectory
          ?? summary.workingDirectory;
        const executor = checklistExecutor;
        const activeSlot = runtimes.get(conversationId);
        const executionRefusal = checklistExecutionRefusal({
          orchestrationTaskId: summary.orchestrationTaskId,
          hasHost: executor !== undefined,
          hostAbsence: CHECKLIST_EXECUTION_UNAVAILABLE,
          workingDirectory,
          requiresWorkingDirectory: true,
          hasActiveRuntime: activeSlot !== undefined,
          requiresActiveRuntime: true,
        });
        if (executionRefusal !== undefined || !executor || !activeSlot || !workingDirectory) {
          throw new Error(executionRefusal ?? CHECKLIST_EXECUTION_UNAVAILABLE);
        }
        const result = await suspendExecutionLeaseForChecklist(
          conversationId,
          activeSlot,
          () => executor({
            conversationId,
            runRef: summary.runRef,
            title: parseRunTitle(summary.title)?.title ?? summary.title,
            workingDirectory,
            request,
          }),
        );
        if (result.status === "completed") {
          pendingWorkingDirectories.set(conversationId, result.workingDirectory);
        }
        return result;
      },
      onPipelineStep: (event) => beginPipelineStep(conversationId, event),
      onPipelineOutput: (artifact) => savePipelineOutput(conversationId, artifact),
      onPipelineDecision: (artifact) => savePipelineDecision(conversationId, artifact),
      onRolesChanged: (roles) => {
        const execution = runtimeContexts.get(conversationId);
        if (!execution) {
          return;
        }
        execution.roles = { ...roles };
        const runtimeState = runtimes.get(conversationId)?.runtime.getState();
        Object.entries(runtimeState?.agents ?? {}).forEach(([agentId, agent]) =>
          syncAgentChat(conversationId, agentId, agent)
        );
      },
      onAgentState: (agentId, agent) => syncAgentChat(conversationId, agentId, agent),
      executeQueuedPipeline: (request, onAccepted) =>
        queuedPipelineExecutor(conversationId, request, onAccepted),
      executeQueuedDirect: (request, onAccepted) =>
        queuedDirectExecutor(conversationId, request, onAccepted),
    });
    const slot: RuntimeSlot = { runtime };
    runtimes.set(conversationId, slot);
    if (attach) {
      attachProxy(conversationId, slot);
    }
    try {
      await runtime.handleMessage({ type: "ready" });
      return slot;
    } catch (error) {
      slot.proxy?.dispose();
      runtimes.delete(conversationId);
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  };

  const assertConversationCapacity = (): void => {
    const activeCount = state.conversations.filter(
      (conversation) => !conversation.archived && !conversation.parentConversationId,
    ).length;
    if (activeCount >= maximumActiveConversations) {
      throw new Error(
        `Archive or close a conversation before creating more than ${String(maximumActiveConversations)} active runs`,
      );
    }
  };

  const runtimeIsBusy = (conversationId: string): boolean => {
    if (
      activeConversationRuns.has(conversationId) ||
      executionLeaseAcquisitions.has(conversationId) ||
      executionLeaseControllers.has(conversationId) ||
      (executionLeases.get(conversationId)?.users.size ?? 0) > 0 ||
      suspendedExecutionUsers.has(conversationId) ||
      (activeRuntimeMessages.get(conversationId) ?? 0) > 0
    ) {
      return true;
    }
    const slot = runtimes.get(conversationId);
    if (!slot) {
      return false;
    }
    const runtimeState = slot.runtime.getState();
    return (
      slot.runtime.isBusy() ||
      runtimeState.running ||
      Object.values(runtimeState.agents).some(
        (agent) => agent.status === "running",
      ) ||
      runtimeState.approvals.length > 0
    );
  };

  const createConversation = async (
    options: ConversationCreateOptions = {},
  ): Promise<ConversationSummary> => {
    if (!options.parentConversationId) {
      assertConversationCapacity();
    }
    await ensureCanonicalRepositoryRoot(options.workingDirectory ?? options.pipelineScopeRoot);
    if (options.parentConversationId) {
      const parent = findSummary(options.parentConversationId);
      if (parent.archived) {
        throw new Error("Unarchive the parent run before creating task conversations");
      }
    }
    const readableTitle = options.title?.trim().slice(0, 96) || "New run";
    const requestedPipelineId = options.pipelineSnapshot?.definition.id ?? options.pipelineId;
    if (
      options.pipelineSnapshot &&
      options.pipelineId &&
      options.pipelineSnapshot.definition.id !== options.pipelineId
    ) {
      throw new Error("Conversation pipeline id does not match its immutable snapshot");
    }
    const run = catalog.createRun({
      title: readableTitle,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(requestedPipelineId === undefined ? {} : { pipelineId: requestedPipelineId }),
      iterationCount: Math.max(
        1,
        Math.min(
          maximumPipelineIterations,
          options.iterationCount ?? defaultPipelineIterations,
        ),
      ),
      ...(options.workingDirectory === undefined ? {} : { workingRoot: options.workingDirectory }),
      ...(options.preparedDraft === undefined ? {} : { preparedDraft: options.preparedDraft }),
      ...(options.parentConversationId === undefined ? {} : { parentConversationId: options.parentConversationId }),
      ...(options.orchestrationRunId === undefined ? {} : { orchestrationRunId: options.orchestrationRunId }),
      ...(options.orchestrationTaskId === undefined ? {} : { orchestrationTaskId: options.orchestrationTaskId }),
      ...(options.orchestrationBranch === undefined ? {} : { orchestrationBranch: options.orchestrationBranch }),
      ...(options.orchestrationBaseCommit === undefined ? {} : { orchestrationBaseCommit: options.orchestrationBaseCommit }),
      ...(options.orchestrationPaths === undefined ? {} : { orchestrationPaths: options.orchestrationPaths }),
      ...(options.pipelineScopeRoot === undefined ? {} : { pipelineScopeRoot: options.pipelineScopeRoot }),
      status: "draft",
    });
    run.title = formatRunTitle(run.runRef, readableTitle);
    if (options.runSettings) {
      replaySourceSettings.set(run.runRef, options.runSettings);
      run.replaySourceSettings = options.runSettings;
    }
    catalog.upsertRun(run);
    const summary = createSummary(run.runRef, run.runRef, run.title, {
      ...(options.parentConversationId === undefined ? {} : { parentConversationId: options.parentConversationId }),
      ...(options.orchestrationRunId === undefined ? {} : { orchestrationRunId: options.orchestrationRunId }),
      ...(options.orchestrationTaskId === undefined ? {} : { orchestrationTaskId: options.orchestrationTaskId }),
      ...(options.orchestrationBranch === undefined ? {} : { orchestrationBranch: options.orchestrationBranch }),
      ...(options.orchestrationBaseCommit === undefined ? {} : { orchestrationBaseCommit: options.orchestrationBaseCommit }),
      ...(options.orchestrationPaths === undefined ? {} : { orchestrationPaths: options.orchestrationPaths }),
      ...(options.pipelineScopeRoot === undefined ? {} : { pipelineScopeRoot: options.pipelineScopeRoot }),
    });
    setOptionalProperty(summary, "input", options.input);
    setOptionalProperty(summary, "preparedDraft", options.preparedDraft);
    if (options.reviewCandidate !== undefined) {
      summary.reviewCandidate = options.reviewCandidate;
    }
    summary.iterationCount = run.iterationCount;
    setOptionalProperty(summary, "selectedPipelineId", requestedPipelineId);
    setOptionalProperty(summary, "pipelineScopeRoot", options.pipelineScopeRoot);
    setOptionalProperty(summary, "workingDirectory", options.workingDirectory);
    const previousActiveConversationId = state.activeConversationId;
    state.conversations.push(summary);
    state.activeConversationId = summary.id;
    try {
      const slot = await ensureRuntime(summary.id, false);
      if (requestedPipelineId || options.pipelineSnapshot || options.workingDirectory) {
        await slot.runtime.configure({
          ...(requestedPipelineId ? { pipelineId: requestedPipelineId } : {}),
          ...(options.pipelineSnapshot
            ? { pipelineSnapshot: structuredClone(options.pipelineSnapshot) }
            : {}),
          ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
        });
      }
      const runtimeState = slot.runtime.getState();
      setOptionalProperty(summary, "selectedPipelineId", runtimeState.selectedPipelineId);
      setOptionalProperty(summary, "selectedPipelineHash", runtimeState.selectedPipelineHash);
      setOptionalProperty(summary, "pipelineScopeRoot", runtimeState.pipelineScopeRoot);
      setOptionalProperty(summary, "workingDirectory", runtimeState.workingDirectory);
      catalog.appendEvent({
        runRef: summary.runRef,
        type: "run.created",
        status: "draft",
        title: summary.title,
      });
      attachProxy(summary.id, slot);
      await persist();
      emitSnapshot();
      return summary;
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      state.conversations = state.conversations.filter(
        (item) => item.id !== summary.id,
      );
      state.activeConversationId = previousActiveConversationId;
      const slot = runtimes.get(summary.id);
      if (slot) {
        slot.proxy?.dispose();
        await slot.runtime.dispose().catch((cleanupError) => {
          cleanupFailures.push(cleanupError);
        });
        runtimes.delete(summary.id);
      }
      runtimeContexts.delete(summary.id);
      activeRuntimeMessages.delete(summary.id);
      pendingWorkingDirectories.delete(summary.id);
      releaseBrowserBindings(summary.id);
      const runtimeOptions = runtimeStorage(summary.id);
      await withWorkspaceMutation(async () => {
        await context.workspaceState.update(runtimeOptions.storageKey, undefined);
        await rm(runtimeOptions.storageDirectory, {
          recursive: true,
          force: true,
        });
      }).catch((cleanupError) => {
        cleanupFailures.push(cleanupError);
      });
      try {
        catalog.deleteRun(summary.runRef);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Conversation creation failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  };

  const currentWorkspaceLocations = async (): Promise<Array<{
    displayRoot: string;
    canonicalRoot: string;
  }>> => {
    const results = await Promise.all(
      (vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
        const displayRoot = path.resolve(folder.uri.fsPath);
        const canonicalRoot = await realpath(displayRoot).catch(() => undefined);
        return canonicalRoot ? { displayRoot, canonicalRoot } : undefined;
      }),
    );
    return results.filter((value): value is {
      displayRoot: string;
      canonicalRoot: string;
    } => value !== undefined);
  };

  const duplicateConversation = async (
    conversationId: string,
  ): Promise<ConversationSummary> => {
    const source = findSummary(conversationId);
    if (runtimeIsBusy(conversationId)) {
      throw new Error("Interrupt the run before copying its input");
    }
    const roots = await currentWorkspaceLocations();
    const canonicalScopeRoot = source.pipelineScopeRoot
      ? await realpath(source.pipelineScopeRoot).catch(() => undefined)
      : undefined;
    const currentScope = canonicalScopeRoot
      ? roots.find((root) => root.canonicalRoot === canonicalScopeRoot)
      : undefined;
    const canonicalWorkingDirectory = source.workingDirectory
      ? await realpath(source.workingDirectory).catch(() => undefined)
      : undefined;
    const workingDirectoryIsCurrent = Boolean(
      canonicalWorkingDirectory &&
      roots.some((root) =>
        isPathAtOrInside(root.canonicalRoot, canonicalWorkingDirectory)
      ),
    );
    const scopeWasRemoved = Boolean(source.pipelineScopeRoot && !currentScope);
    return createConversation({
      title: `${(parseRunTitle(source.title)?.title ?? source.title).slice(0, 88)} copy`,
      ...(source.input === undefined ? {} : { input: source.input }),
      pipelineId: scopeWasRemoved ? "review-only" : source.selectedPipelineId,
      iterationCount: source.iterationCount,
      ...(workingDirectoryIsCurrent && source.workingDirectory
        ? { workingDirectory: source.workingDirectory }
        : {}),
      ...(currentScope ? { pipelineScopeRoot: currentScope.displayRoot } : {}),
    });
  };

  const conversationSubtree = (conversationId: string): ConversationSummary[] => {
    findSummary(conversationId);
    const ids = new Set([conversationId]);
    let changed = true;
    while (changed) {
      changed = false;
      state.conversations.forEach((conversation) => {
        if (conversation.parentConversationId && ids.has(conversation.parentConversationId) && !ids.has(conversation.id)) {
          ids.add(conversation.id);
          changed = true;
        }
      });
    }
    return state.conversations.filter((conversation) => ids.has(conversation.id));
  };

  const rootConversation = (conversationId: string): ConversationSummary => {
    let current = findSummary(conversationId);
    const seen = new Set<string>();
    while (current.parentConversationId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = state.conversations.find((item) => item.id === current.parentConversationId);
      if (!parent) {
        break;
      }
      current = parent;
    }
    return current;
  };

  const disposeConversationRuntime = async (
    summary: ConversationSummary,
    preserveBrowserReservations: boolean,
  ): Promise<void> => {
    const slot = runtimes.get(summary.id);
    if (!slot) {
      return;
    }
    const bindings = preserveBrowserReservations
      ? Object.entries(slot.runtime.getState().agents)
          .filter(([, agent]) => agent.browserBinding)
          .map(([agentId, agent]) => ({
            ownerId: `${summary.id}:${agentId}`,
            binding: agent.browserBinding as BrowserConversationBinding,
          }))
      : [];
    slot.proxy?.dispose();
    try {
      await slot.runtime.dispose();
    } finally {
      runtimes.delete(summary.id);
      bindings.forEach(({ ownerId, binding }) => {
        try {
          sharedBridge.bindConversation(ownerId, binding);
        } catch (error) {
          output.appendLine(
            `Could not preserve browser reservation for ${ownerId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }
  };

  /**
   * EX-3. Undoing a replacement run this operation created. Archive and delete both create one
   * when the change would leave the panel with nowhere to be, and both had to take the same four
   * steps back — dispose the runtime, drop its storage key, remove its directory, delete the run —
   * written out twice. Every failure is collected so the caller can report all of them.
   */
  const rollbackCreatedReplacement = async (
    replacement: ConversationSummary,
    failures: unknown[],
  ): Promise<void> => {
    const slot = runtimes.get(replacement.id);
    if (slot) {
      slot.proxy?.dispose();
      await slot.runtime.dispose().catch((error) => { failures.push(error); });
      runtimes.delete(replacement.id);
    }
    const runtimeOptions = runtimeStorage(replacement.id);
    await withWorkspaceMutation(async () => {
      await context.workspaceState.update(runtimeOptions.storageKey, undefined);
      await rm(runtimeOptions.storageDirectory, { recursive: true, force: true });
    }).catch((error) => { failures.push(error); });
    try {
      catalog.deleteRun(replacement.runRef);
    } catch (error) {
      failures.push(error);
    }
  };

  const archiveConversation = async (
    conversationId: string,
    archived: boolean,
  ): Promise<void> => {
    const root = rootConversation(conversationId);
    const subtree = conversationSubtree(root.id);
    if (!archived && root.archived) {
      assertConversationCapacity();
    }
    const archiveBusy = busyConversationRefusal(
      subtree.find((conversation) => runtimeIsBusy(conversation.id))?.title,
      "archive",
    );
    if (archiveBusy !== undefined) {
      throw new Error(archiveBusy);
    }
    const subtreeIds = new Set(subtree.map((item) => item.id));
    const nextConversations = structuredClone(state.conversations);
    const now = new Date().toISOString();
    nextConversations.forEach((summary) => {
      if (subtreeIds.has(summary.id)) {
        summary.archived = archived;
        summary.updatedAt = now;
      }
    });
    let nextActiveConversationId = state.activeConversationId;
    let createdReplacement: ConversationSummary | undefined;
    let replacementSlot: RuntimeSlot | undefined;
    const disposedSummaries: ConversationSummary[] = [];
    try {
      if (archived && subtreeIds.has(state.activeConversationId)) {
        const choice = archiveReplacementChoice({
          candidates: nextConversations,
          archivedIds: subtreeIds,
        });
        let replacement = choice.kind === "existing"
          ? nextConversations.find((item) => item.id === choice.conversationId)
          : undefined;
        if (!replacement) {
          const run = catalog.createRun({
            title: "New run",
            iterationCount: defaultPipelineIterations,
            status: "draft",
          });
          run.title = formatRunTitle(run.runRef, "New run");
          catalog.upsertRun(run);
          replacement = summaryFromCatalog(run);
          createdReplacement = replacement;
          nextConversations.push(replacement);
          replacementSlot = await ensureRuntime(replacement.id, false, replacement);
        } else {
          replacementSlot = await ensureRuntime(replacement.id);
        }
        replacement.unread = 0;
        nextActiveConversationId = replacement.id;
      }
      if (archived) {
        for (const summary of subtree) {
          if (runtimes.has(summary.id)) {
            disposedSummaries.push(summary);
            await disposeConversationRuntime(summary, true);
          }
        }
      }
      await persistManagerState(nextConversations, nextActiveConversationId);
      state.conversations = nextConversations;
      state.activeConversationId = nextActiveConversationId;
      if (replacementSlot) {
        attachProxy(nextActiveConversationId, replacementSlot);
      }
      emitSnapshot();
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      for (const summary of disposedSummaries) {
        await ensureRuntime(summary.id).catch((rollbackError) => {
          rollbackFailures.push(rollbackError);
        });
      }
      if (createdReplacement) {
        await rollbackCreatedReplacement(createdReplacement, rollbackFailures);
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError([error, ...rollbackFailures], ARCHIVE_ROLLBACK_INCOMPLETE);
      }
      throw error;
    }
  };

  const removeConversation = async (conversationId: string): Promise<void> => {
    const root = rootConversation(conversationId);
    const subtree = conversationSubtree(root.id);
    const deleteBusy = busyConversationRefusal(
      subtree.find((conversation) => runtimeIsBusy(conversation.id))?.title,
      "delete",
    );
    if (deleteBusy !== undefined) {
      throw new Error(deleteBusy);
    }
    const removedIds = new Set(subtree.map((item) => item.id));
    const removedRunRefs = subtree.map((item) => item.runRef);
    const nextConversations = structuredClone(
      state.conversations.filter((item) => !removedIds.has(item.id)),
    );
    const openInteractions = subtree.flatMap((summary) =>
      catalog.listOpenInteractions(summary.runRef)
    );
    const browserOwnerIds = new Set<string>();
    subtree.forEach((summary) => {
      persistedBrowserBindings(summary.id).forEach(({ agentId }) => {
        browserOwnerIds.add(`${summary.id}:${agentId}`);
      });
      Object.keys(runtimes.get(summary.id)?.runtime.getState().agents ?? {}).forEach((agentId) => {
        browserOwnerIds.add(`${summary.id}:${agentId}`);
      });
    });

    let createdReplacement: ConversationSummary | undefined;
    let nextActiveConversationId: string | undefined;
    let activeSlot: RuntimeSlot | undefined;
    const disposedSummaries: ConversationSummary[] = [];
    let staged: StagedConversationDeletion | undefined;
    try {
      const activeChoice = deletionActiveChoice({
        remaining: nextConversations,
        activeConversationId: state.activeConversationId,
        removedIds,
      });
      const fallback = activeChoice.fallback;
      let activeRoot = fallback.kind === "existing"
        ? nextConversations.find((item) => item.id === fallback.conversationId)
        : undefined;
      if (!activeRoot) {
        const run = catalog.createRun({
          title: "New run",
          iterationCount: defaultPipelineIterations,
          status: "draft",
        });
        run.title = formatRunTitle(run.runRef, "New run");
        catalog.upsertRun(run);
        activeRoot = summaryFromCatalog(run);
        createdReplacement = activeRoot;
        nextConversations.push(activeRoot);
      }
      nextActiveConversationId = activeChoice.keepsActive
        ? state.activeConversationId
        : activeRoot.id;
      const nextActive = nextConversations.find(
        (conversation) => conversation.id === nextActiveConversationId,
      );
      if (!nextActive) {
        throw new Error("No active conversation remains after deletion");
      }
      nextActive.unread = 0;
      activeSlot = await ensureRuntime(
        nextActive.id,
        false,
        createdReplacement?.id === nextActive.id ? createdReplacement : undefined,
      );
      for (const summary of subtree) {
        if (!runtimes.has(summary.id)) {
          continue;
        }
        disposedSummaries.push(summary);
        await disposeConversationRuntime(summary, false);
      }
      staged = await stageConversationDeletion(subtree);
      await persistManagerState(
        nextConversations,
        nextActiveConversationId,
        removedRunRefs,
      );
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      if (staged) {
        await restoreStagedConversationDeletion(staged).catch((rollbackError) => {
          rollbackFailures.push(rollbackError);
        });
      }
      for (const summary of disposedSummaries) {
        await ensureRuntime(summary.id).catch((rollbackError) => {
          rollbackFailures.push(rollbackError);
        });
      }
      if (createdReplacement) {
        await rollbackCreatedReplacement(createdReplacement, rollbackFailures);
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError([error, ...rollbackFailures], DELETION_ROLLBACK_INCOMPLETE);
      }
      throw error;
    }

    if (!nextActiveConversationId) {
      throw new Error("Conversation deletion committed without an active replacement");
    }
    state.conversations = nextConversations;
    state.activeConversationId = nextActiveConversationId;
    subtree.forEach((summary) => {
      runtimeContexts.delete(summary.id);
      activeRuntimeMessages.delete(summary.id);
      pendingWorkingDirectories.delete(summary.id);
      for (const key of Array.from(chatRefs.keys())) {
        if (key.startsWith(`${summary.runRef}:`)) {
          chatRefs.delete(key);
        }
      }
    });
    browserOwnerIds.forEach((ownerId) => sharedBridge.releaseBinding(ownerId));
    openInteractions.forEach((interaction) => {
      resolveInteractionWaiters(interaction.interactionRef, {
        selected: [],
        freeText: "",
        source: "cancel",
      });
    });
    deadlineScheduler.wake();
    if (activeSlot) {
      attachProxy(nextActiveConversationId, activeSlot);
    }
    emitSnapshot();
    if (staged) {
      await withWorkspaceMutation(() =>
        rm(staged.directory, { recursive: true, force: true })
      ).catch((error) => {
        output.appendLine(
          `Run deletion committed, but staged storage cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  };

  const updateExecutionTerminalState = (
    conversationId: string,
    status: "completed" | "interrupted" | "failed",
  ): void => {
    const execution = runtimeContexts.get(conversationId);
    if (execution?.activeStepRef) {
      catalog.updateStep(execution.activeStepRef, {
        status: status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
        completed: true,
      });
    }
    if (execution?.pairRef) {
      catalog.updatePair(execution.pairRef, {
        status: status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
        completed: true,
      });
    }
  };

  const executeConversationIteration = async (input: {
    conversationId: string;
    summary: ConversationSummary;
    slot: RuntimeSlot;
    prompt: string;
    attachmentIds: string[];
    displayIndex: number;
    persistedIndex: number;
    requestedIterations: number;
    iterationRef?: string | undefined;
    pairRef?: string | undefined;
    resume?: boolean | undefined;
    appendPrompt?: boolean | undefined;
    sourceQueueMessageId?: string | undefined;
    pipelineSnapshot?: PipelineSnapshot | undefined;
    requireCurrentCatalog?: boolean | undefined;
    writeScope?: WorkspaceWriteScope | undefined;
    commitMode?: "never" | "allow" | undefined;
    trackWorkspaceChanges?: boolean | undefined;
    onAccepted?: (() => Promise<void> | void) | undefined;
    onRuntimeAccepted?: (() => Promise<void> | void) | undefined;
  }): Promise<PipelineRunResult> => {
    let iterationRef = input.iterationRef;
    let pairRef = input.pairRef;
    try {
      if (!iterationRef) {
        iterationRef = catalog.createIteration({
          runRef: input.summary.runRef,
          index: input.persistedIndex,
          status: "running",
        });
      } else {
        catalog.updateIteration(iterationRef, { status: "running", completed: false });
      }

      const runtimeState = input.slot.runtime.getState();
      const pipelineDefinition = input.pipelineSnapshot?.definition ??
        runtimeState.selectedPipelineDefinition;
      const pairPipeline = isPairPipeline({
        orchestrationTaskId: input.summary.orchestrationTaskId,
        roles: pipelineDefinition?.roles,
      });
      if (!pairRef && pairPipeline) {
        pairRef = catalog.createPair(pairRecordFrom({
          runRef: input.summary.runRef,
          iterationRef,
          orchestrationTaskId: input.summary.orchestrationTaskId,
          orchestrationBranch: input.summary.orchestrationBranch,
          orchestrationBaseCommit: input.summary.orchestrationBaseCommit,
          orchestrationPaths: input.summary.orchestrationPaths,
          workingDirectory: runtimeState.workingDirectory ?? input.summary.workingDirectory,
        }));
      } else if (pairRef) {
        catalog.updatePair(pairRef, { status: "running", completed: false });
      }

      runtimeContexts.set(input.conversationId, {
        iterationRef,
        pairRef,
        stepRefs: new Map(),
        roles: { ...runtimeState.roles },
      });

      if (!input.resume) {
        await input.slot.runtime.resetSessions();
      }
      Object.entries(input.slot.runtime.getState().agents).forEach(([agentId, agent]) =>
        syncAgentChat(input.conversationId, agentId, agent)
      );
      catalog.appendEvent({
        runRef: input.summary.runRef,
        iterationRef,
        pairRef,
        ...iterationStartEvent({
          resume: input.resume === true,
          displayIndex: input.displayIndex,
          requestedIterations: input.requestedIterations,
        }),
        status: "running",
      });
      await persist();
      emitSnapshot();
      await input.onAccepted?.();

      const result = input.resume
        ? await input.slot.runtime.resumePipeline({
            ...(input.onRuntimeAccepted === undefined ? {} : { onAccepted: input.onRuntimeAccepted }),
          })
        : await input.slot.runtime.runPipeline(input.prompt, input.attachmentIds, {
            ...(input.onRuntimeAccepted === undefined ? {} : { onAccepted: input.onRuntimeAccepted }),
            ...(input.appendPrompt === undefined ? {} : { appendPrompt: input.appendPrompt }),
            ...(input.sourceQueueMessageId === undefined ? {} : { sourceQueueMessageId: input.sourceQueueMessageId }),
            ...(input.pipelineSnapshot
              ? { pipelineSnapshot: input.pipelineSnapshot }
              : {}),
            ...(input.requireCurrentCatalog === undefined ? {} : { requireCurrentCatalog: input.requireCurrentCatalog }),
            ...(input.summary.orchestrationPaths?.length
              ? { allowedPaths: [...input.summary.orchestrationPaths] }
              : {}),
            ...((): { writeScope?: WorkspaceWriteScope } => {
              const writeScope = impliedWriteScope({
                requested: input.writeScope,
                orchestrationPaths: input.summary.orchestrationPaths,
              });
              return writeScope === undefined ? {} : { writeScope };
            })(),
            ...(input.commitMode ? { commitMode: input.commitMode } : {}),
            ...(input.trackWorkspaceChanges ? { trackWorkspaceChanges: true } : {}),
          });
      if (result.status === "completed") {
        const nextWorkingDirectory = pendingWorkingDirectories.get(input.conversationId);
        if (nextWorkingDirectory) {
          const selectedPipelineId = input.slot.runtime.getState().selectedPipelineId;
          if (!selectedPipelineId) {
            throw new Error("The completed checklist run has no selected pipeline");
          }
          await input.slot.runtime.configure({
            pipelineId: selectedPipelineId,
            workingDirectory: nextWorkingDirectory,
            preserveHistory: true,
          });
          input.summary.workingDirectory = nextWorkingDirectory;
          pendingWorkingDirectories.delete(input.conversationId);
        }
      }

      updateExecutionTerminalState(input.conversationId, result.status);
      catalog.updateIteration(iterationRef, {
        status: result.status,
        completed: true,
      });
      catalog.appendEvent({
        runRef: input.summary.runRef,
        iterationRef,
        pairRef,
        ...iterationEndEvent({ status: result.status, displayIndex: input.displayIndex }),
        status: result.status,
      });
      return result;
    } catch (error) {
      const failure = iterationFailurePlan({
        resume: input.resume === true,
        hasResumableWorkflow: input.slot.runtime.getState().resumableWorkflow !== undefined,
        displayIndex: input.displayIndex,
        error,
      });
      if (iterationRef) {
        updateExecutionTerminalState(input.conversationId, failure.status);
        catalog.updateIteration(iterationRef, { status: failure.status, completed: true });
        catalog.appendEvent({
          runRef: input.summary.runRef,
          iterationRef,
          pairRef,
          type: failure.eventType,
          status: failure.status,
          title: failure.title,
          payload: { message: failure.message },
        });
      }
      input.summary.running = false;
      input.summary.workflowStatus = failure.workflowStatus;
      input.summary.updatedAt = new Date().toISOString();
      if (failure.dropPendingWorkingDirectory) {
        pendingWorkingDirectories.delete(input.conversationId);
      }
      await persist();
      emitSnapshot();
      throw error;
    } finally {
      runtimeContexts.delete(input.conversationId);
    }
  };

  const contractVerificationCommands = (slot: RuntimeSlot): string[] => {
    const definition = runtimePipelineSnapshot(slot.runtime)?.definition;
    const policy = definition?.managedPolicy;
    const roleChecks = (definition?.roles ?? []).flatMap((role) => role.verificationChecks ?? []);
    return Array.from(new Set(
      [...(policy?.verificationChecks ?? []), ...roleChecks].map((check) => check.command),
    ));
  };

  const runContractVerification = async (
    summary: ConversationSummary,
    slot: RuntimeSlot,
    status: PipelineRunResult["status"],
  ): Promise<void> => {
    if (status !== "completed") return;
    const commands = contractVerificationCommands(slot);
    const cwd = summary.workingDirectory;
    if (commands.length === 0 || cwd === undefined) return;
    if (summary.orchestrationTaskId !== undefined || summary.orchestrationRunId !== undefined) return;
    const settings = vscode.workspace.getConfiguration("bachata");
    let checks: Awaited<ReturnType<typeof runVerificationChecks>>;
    try {
      checks = await runVerificationChecks(commands, {
        cwd,
        timeoutMs: readTimeoutSetting((settingKey, settingFallback) => settings.get(settingKey, settingFallback), "todoCheckTimeoutMs", 30 * 60_000),
        maxOutputBytes: settings.get<number>("todoCheckMaxOutputBytes", 2_097_152),
        environment: configuredProcessEnvironment(
          cwd,
          settings.get<string[]>("todoCheckEnvironmentVariables", []),
        ),
        autonomous: true,
      });
    } catch (error) {
      output.appendLine(
        `Contract verification failed to start for ${summary.runRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    catalog.appendEvent({
      runRef: summary.runRef,
      type: "verification.completed",
      status: checks.every((check) => check.status === "passed") ? "completed" : "failed",
      title: "Controller verification",
      payload: {
        checks: checks.map((check) => ({ command: check.command, status: check.status })),
      },
    });
  };

  const finishConversationRun = async (
    conversationId: string,
    summary: ConversationSummary,
    slot: RuntimeSlot,
    iterations: PipelineRunResult[],
    requestedIterations: number,
    completedIterationsBefore = 0,
  ): Promise<ConversationExecutionResult> => {
    const pipeline = iterations.at(-1);
    if (!pipeline) {
      throw new Error("Pipeline ended without an iteration result");
    }
    const runtimeState = slot.runtime.getState();
    summary.running = runtimeState.running;
    summary.workflowStatus = runtimeState.workflowStatus;
    setOptionalProperty(summary, "selectedPipelineId", runtimeState.selectedPipelineId);
    setOptionalProperty(summary, "selectedPipelineHash", runtimeState.selectedPipelineHash);
    setOptionalProperty(summary, "pipelineScopeRoot", runtimeState.pipelineScopeRoot);
    setOptionalProperty(summary, "workingDirectory", runtimeState.workingDirectory);
    summary.updatedAt = new Date().toISOString();
    catalog.appendEvent({
      runRef: summary.runRef,
      type: pipeline.status === "interrupted" ? "run.interrupted" : "run.completed",
      status: pipeline.status,
      title: summary.title,
      payload: {
        completedIterations:
          completedIterationsBefore +
          iterations.filter((iteration) => iteration.status === "completed").length,
        requestedIterations,
      },
    });
    await runContractVerification(summary, slot, pipeline.status);
    await persist();
    emitSnapshot();
    return { conversationId, pipeline, iterations };
  };

  const runConversationOwned = async (
    conversationId: string,
    prompt: string,
    attachmentIds: string[] = [],
    iterationCount?: number,
    options: ConversationRunOptions = {},
  ): Promise<ConversationExecutionResult> => {
    await ensureInitialized();
    const summary = findSummary(conversationId);
    if (summary.archived) {
      throw new Error("Unarchive the run before starting it");
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      throw new Error("Run input is required");
    }
    const requestedIterations = Math.max(
      1,
      Math.min(
        maximumPipelineIterations,
        iterationCount ?? summary.iterationCount ?? defaultPipelineIterations,
      ),
    );
    const iterationMode = options.iterationMode ?? "fixed";
    const requiredCleanPasses = Math.max(
      1,
      Math.min(10, options.requiredCleanPasses ?? 2),
    );
    const slot = await ensureRuntime(conversationId);
    let pipelineSnapshot = options.pipelineSnapshot ??
      runtimePipelineSnapshot(slot.runtime);
    const requireCurrentCatalog = options.pipelineSnapshot === undefined;
    pipelineSnapshot = await slot.runtime.preflightPipeline(
      trimmedPrompt,
      attachmentIds,
      pipelineSnapshot,
      {
        requireCurrentCatalog,
        ...(options.composerAuthorized ? { composerAuthorized: true } : {}),
      },
    );
    if (
      options.requirePipelineHash !== undefined &&
      pipelineSnapshot !== undefined &&
      pipelineSnapshot.hash !== options.requirePipelineHash
    ) {
      throw new Error(
        `Bachata refused this run: the workflow ${pipelineSnapshot.definition.id} changed after it was validated, so the authority Bachata checked is not the authority that would run.`,
      );
    }
    // EX-A5-R04. The executed pipeline is known here and nowhere later, so the expectations it
    // fixes are recorded with the run rather than re-derived from a runtime that may be gone.
    rememberEvidenceExpectations(summary.runRef, pipelineSnapshot?.definition);
    // What actually answered for each declared dependency is recorded with the run, so a
    // later reader can tell a reproducible resource from one that merely happened to be there.
    const dependencyProvenance = slot.runtime.getResourceDependencyProvenance?.() ?? [];
    if (dependencyProvenance.length > 0) {
      catalog.appendEvent({
        runRef: summary.runRef,
        type: "resourceDependencies.observed",
        status: "completed",
        title: "Declared resource dependencies",
        payload: { dependencies: dependencyProvenance },
      });
    }
    // Intent is declared by the workflow, not guessed from the command that started it. A
    // workflow whose result belongs to an initiative refuses here, before any provider runs,
    // rather than succeeding and discarding what it produced.
    const declaredIntent = pipelineSnapshot?.definition.longitudinalIntent ?? "runLocal";
    if (summary.longitudinalIntent !== declaredIntent) {
      summary.longitudinalIntent = declaredIntent;
      await persist();
    }
    if (declaredIntent === "initiativeRequired") {
      const service = longitudinalFor(conversationRepositoryRoot(summary));
      if (service.currentInitiative() === undefined) {
        throw new Error(
          `Bachata refused this run before starting any provider: ${pipelineSnapshot?.definition.name ?? "this workflow"} records its result against an initiative, and this repository has none. `
          + "Open the Direction view and state the goal, or run Bachata: Setup, then start the run again.",
        );
      }
    }
    bindConversationRun(summary);
    const priorIterations = catalog.listIterations(summary.runRef);
    const startIndex = (priorIterations.at(-1)?.index ?? 0) + 1;
    const iterations: PipelineRunResult[] = [];
    try {
      summary.input = trimmedPrompt;
      delete summary.preparedDraft;
      if (pipelineSnapshot) {
        summary.selectedPipelineId = pipelineSnapshot.definition.id;
        summary.selectedPipelineHash = pipelineSnapshot.hash;
        setOptionalProperty(summary, "pipelineScopeRoot", pipelineSnapshot.scopeRoot);
      }
      summary.iterationCount = requestedIterations;
      summary.activeIteration = 1;
      summary.running = true;
      summary.workflowStatus = "running";
      if (
        parseRunTitle(summary.title)?.title === "New run" ||
        summary.title === "New conversation"
      ) {
        summary.title = formatRunTitle(summary.runRef, titleFromPrompt(trimmedPrompt));
      }
      summary.updatedAt = new Date().toISOString();
      catalog.appendEvent({
        runRef: summary.runRef,
        type: "run.started",
        status: "running",
        title: summary.title,
        payload: {
          iterations: requestedIterations,
          iterationMode,
          ...(iterationMode === "untilClean" ? { requiredCleanPasses } : {}),
        },
      });
      terminalResults.delete(summary.runRef);
      latestRechecks.delete(summary.runRef);
      await persist();
      emitSnapshot();

      let cleanPasses = 0;
      for (let offset = 0; offset < requestedIterations; offset += 1) {
        if (offset > 0) {
          await ensureContinuationExecutionLease(conversationId, slot);
        }
        const displayIndex = offset + 1;
        summary.activeIteration = displayIndex;
        summary.updatedAt = new Date().toISOString();
        const result = await executeConversationIteration({
          conversationId,
          summary,
          slot,
          prompt: trimmedPrompt,
          attachmentIds,
          displayIndex,
          persistedIndex: startIndex + offset,
          requestedIterations,
          ...(options.appendPrompt === undefined ? {} : { appendPrompt: options.appendPrompt }),
          ...(options.sourceQueueMessageId === undefined ? {} : { sourceQueueMessageId: options.sourceQueueMessageId }),
          pipelineSnapshot,
          requireCurrentCatalog: offset === 0 ? requireCurrentCatalog : false,
          onAccepted: offset === 0 ? options.onAccepted : undefined,
          onRuntimeAccepted: offset === 0 ? options.onRuntimeAccepted : undefined,
          ...(options.writeScope === undefined ? {} : { writeScope: options.writeScope }),
          ...(options.commitMode === undefined ? {} : { commitMode: options.commitMode }),
          trackWorkspaceChanges: iterationMode === "untilClean",
        });
        iterations.push(result);
        if (result.status !== "completed") break;
        if (iterationMode === "untilClean") {
          cleanPasses = result.workspaceChanged === false ? cleanPasses + 1 : 0;
          if (cleanPasses >= requiredCleanPasses) break;
        }
      }
      return await finishConversationRun(
        conversationId,
        summary,
        slot,
        iterations,
        requestedIterations,
      );
    } catch (error) {
      summary.running = false;
      if (summary.workflowStatus === "running") {
        summary.workflowStatus = slot.runtime.getState().resumableWorkflow
          ? "interrupted"
          : "error";
      }
      summary.updatedAt = new Date().toISOString();
      catalog.appendEvent({
        runRef: summary.runRef,
        type: "run.failed",
        status: "failed",
        title: summary.title,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      await persist();
      emitSnapshot();
      throw error;
    }
  };

  const resumeConversationOwned = async (
    conversationId: string,
  ): Promise<ConversationExecutionResult> => {
    await ensureInitialized();
    const summary = findSummary(conversationId);
    if (summary.archived) {
      throw new Error("Unarchive the run before resuming it");
    }
    const slot = await ensureRuntime(conversationId);
    const recovery = slot.runtime.getState().resumableWorkflow;
    const pipelineSnapshot = runtimePipelineSnapshot(slot.runtime);
    const latestIteration = catalog.listIterations(summary.runRef).at(-1);
    const refusal = resumeRefusal({
      archived: summary.archived,
      hasRecovery: recovery !== undefined,
      runtimeProvidesSnapshot: runtimeProvidesPipelineSnapshot(slot.runtime),
      snapshotHash: pipelineSnapshot?.hash,
      recoveryHash: recovery?.pipelineHash,
      latestIterationStatus: latestIteration?.status,
    });
    if (refusal !== undefined || !recovery || !latestIteration) {
      throw new Error(refusal ?? "No recoverable workflow is available");
    }
    const pairRef = catalog.getPairForIteration(latestIteration.iterationRef)?.pairRef;
    const { requestedIterations, displayIndex: currentDisplayIndex } = resumeIterationWindow({
      iterationCount: summary.iterationCount,
      activeIteration: summary.activeIteration,
      maximumIterations: maximumPipelineIterations,
    });
    const iterations: PipelineRunResult[] = [];
    try {
      summary.input = recovery.userPrompt;
      summary.activeIteration = currentDisplayIndex;
      summary.running = true;
      summary.workflowStatus = "running";
      summary.updatedAt = new Date().toISOString();
      catalog.appendEvent({
        runRef: summary.runRef,
        iterationRef: latestIteration.iterationRef,
        pairRef,
        type: "run.resumed",
        status: "running",
        title: summary.title,
        payload: {
          activeIteration: currentDisplayIndex,
          requestedIterations,
        },
      });
      await persist();
      emitSnapshot();

      const resumed = await executeConversationIteration({
        conversationId,
        summary,
        slot,
        prompt: recovery.userPrompt,
        attachmentIds: recovery.attachmentIds,
        displayIndex: currentDisplayIndex,
        persistedIndex: latestIteration.index,
        requestedIterations,
        iterationRef: latestIteration.iterationRef,
        pairRef,
        resume: true,
        appendPrompt: false,
        sourceQueueMessageId: recovery.sourceQueueMessageId,
        pipelineSnapshot,
      });
      iterations.push(resumed);
      if (resumed.status === "completed") {
        for (
          let displayIndex = currentDisplayIndex + 1;
          displayIndex <= requestedIterations;
          displayIndex += 1
        ) {
          await ensureContinuationExecutionLease(conversationId, slot);
          summary.activeIteration = displayIndex;
          summary.updatedAt = new Date().toISOString();
          const result = await executeConversationIteration({
            conversationId,
            summary,
            slot,
            prompt: recovery.userPrompt,
            attachmentIds: recovery.attachmentIds,
            displayIndex,
            persistedIndex: latestIteration.index + (displayIndex - currentDisplayIndex),
            requestedIterations,
            appendPrompt: recovery.sourceQueueMessageId ? false : undefined,
            sourceQueueMessageId: recovery.sourceQueueMessageId,
            pipelineSnapshot,
          });
          iterations.push(result);
          if (result.status !== "completed") {
            break;
          }
        }
      }
      return await finishConversationRun(
        conversationId,
        summary,
        slot,
        iterations,
        requestedIterations,
        currentDisplayIndex - 1,
      );
    } catch (error) {
      const recoverable = Boolean(slot.runtime.getState().resumableWorkflow);
      summary.running = false;
      summary.workflowStatus = recoverable ? "interrupted" : "error";
      summary.updatedAt = new Date().toISOString();
      catalog.appendEvent({
        runRef: summary.runRef,
        type: recoverable ? "run.resume.failed" : "run.failed",
        status: recoverable ? "interrupted" : "failed",
        title: summary.title,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      await persist();
      emitSnapshot();
      throw error;
    }
  };

  const conversationExecutionBusy = (conversationId: string): boolean => {
    const summary = findSummary(conversationId);
    const slot = runtimes.get(conversationId);
    const runtimeState = slot?.runtime.getState();
    return Boolean(
      activeConversationRuns.has(conversationId) ||
      slot?.runtime.isBusy() ||
      summary.running ||
      runtimeState?.running ||
      Object.values(runtimeState?.agents ?? {}).some((agent) => agent.status === "running") ||
      (runtimeState?.approvals.length ?? 0) > 0,
    );
  };

  const claimConversationRun = (conversationId: string): (() => void) => {
    if (activeConversationRuns.has(conversationId)) {
      throw new Error("Conversation execution is already active");
    }
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    activeConversationRuns.add(conversationId);
    activeConversationRunCompletions.set(conversationId, completion);
    return () => {
      activeConversationRuns.delete(conversationId);
      if (activeConversationRunCompletions.get(conversationId) === completion) {
        activeConversationRunCompletions.delete(conversationId);
      }
      resolveCompletion();
    };
  };

  const freshReviewPrompt = (initiative: Initiative): string => [
    "Review the current repository state independently.",
    "",
    `Goal: ${initiative.goal}`,
    ...(initiative.desiredOutcome ? [`Desired outcome: ${initiative.desiredOutcome}`] : []),
    ...(initiative.scope.length > 0 ? [`Scope: ${initiative.scope.join("; ")}`] : []),
    ...(initiative.constraints.length > 0
      ? [`Constraints: ${initiative.constraints.join("; ")}`]
      : []),
    ...(initiative.acceptanceCriteria.length > 0
      ? [`Acceptance criteria: ${initiative.acceptanceCriteria.join("; ")}`]
      : []),
    "",
    "Judge only what the current repository shows. No earlier finding, ruling, decision, or confidence is carried into this review.",
  ].join("\n");

  const freshReviewContractRefusal = (
    pipelineId: string,
    definition: PipelineDefinition,
  ): string | undefined => {
    const level = executionSafetyLevel(definition);
    if (level !== "review") {
      return `${pipelineId} is ${level}, not read-only, so a fresh review would run with write or checklist authority`;
    }
    if (!producesModelFindings(definition)) {
      return `${pipelineId} produces no review findings: no enabled step declares a ${PROPOSED_FINDING_SET_SHAPE} output or a ${RULED_FINDING_SET_SHAPE} consensus candidate, so its rounds could never add material and would falsely look saturated`;
    }
    return undefined;
  };

  const freshReviewSnapshot = async (
    conversationId: string,
    candidateId: string | undefined,
  ): Promise<PipelineSnapshot> => {
    const configured = configuration.get<string>("freshReviewPipelineId", "").trim();
    const validate = async (
      pipelineId: string,
    ): Promise<{ snapshot?: PipelineSnapshot; refusal: string }> => {
      let snapshot: PipelineSnapshot;
      try {
        snapshot = await resolveConversationPipelineSnapshot(conversationId, pipelineId, {
          requireCurrentCatalog: true,
          rejectChecklist: true,
        });
      } catch (error) {
        return {
          refusal: `${pipelineId} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const refusal = freshReviewContractRefusal(pipelineId, snapshot.definition);
      return refusal === undefined ? { snapshot, refusal: "" } : { refusal };
    };
    const candidate = candidateId === undefined ? undefined : await validate(candidateId);
    if (candidate?.snapshot !== undefined) return candidate.snapshot;
    if (configured.length > 0) {
      const fallback = await validate(configured);
      if (fallback.snapshot !== undefined) return fallback.snapshot;
      throw new Error(
        `Bachata refused this fresh review: the configured bachata.freshReviewPipelineId workflow ${fallback.refusal}. Set it to a read-only workflow that produces review findings.`,
      );
    }
    throw new Error(
      candidate === undefined
        ? "Bachata refused this fresh review: no workflow is selected. Select a read-only review workflow that produces findings, or set bachata.freshReviewPipelineId."
        : `Bachata refused this fresh review: the selected workflow ${candidate.refusal}. Select a read-only review workflow that produces findings, or set bachata.freshReviewPipelineId to one.`,
    );
  };

  const scopedFixPrompt = (finding: FindingHistoryEntry, initiative: Initiative): string => [
    "Fix exactly one accepted finding. Change nothing else.",
    "",
    `Finding: ${finding.subject}`,
    `Detail: ${finding.message}`,
    ...(finding.location === undefined
      ? []
      : [`Location: ${finding.location.file}${finding.location.startLine === undefined ? "" : `:${String(finding.location.startLine)}${finding.location.endLine === undefined || finding.location.endLine === finding.location.startLine ? "" : `-${String(finding.location.endLine)}`}`}`]),
    ...(finding.severity === undefined ? [] : [`Severity: ${finding.severity}`]),
    ...(finding.evidence.length > 0
      ? ["", "Evidence recorded for this finding:", ...finding.evidence.map((item) => `- ${item}`)]
      : []),
    ...(finding.challenges.length > 0
      ? ["", "Challenges recorded against it:", ...finding.challenges.map((item) => `- ${item}`)]
      : []),
    "",
    `Initiative goal: ${initiative.goal}`,
    ...(initiative.constraints.length > 0
      ? [`Constraints: ${initiative.constraints.join("; ")}`]
      : []),
    "",
    "The Lead/Worker pipeline accepted this challenged finding as scoped fix input. Convergence is not correctness. Implement the fix inside the declared write scope and report what you changed.",
  ].join("\n");

  const scopedFixSnapshot = async (
    conversationId: string,
    candidateId: string | undefined,
  ): Promise<PipelineSnapshot> => {
    const configured = configuration.get<string>("fixPipelineId", "").trim();
    const validate = async (
      pipelineId: string,
    ): Promise<{ snapshot?: PipelineSnapshot; refusal: string }> => {
      let snapshot: PipelineSnapshot;
      try {
        snapshot = await resolveConversationPipelineSnapshot(conversationId, pipelineId, {
          requireCurrentCatalog: true,
          rejectChecklist: true,
        });
      } catch (error) {
        return {
          refusal: `${pipelineId} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const level = executionSafetyLevel(snapshot.definition);
      if (level === "review") {
        return { refusal: `${pipelineId} is read-only, so it cannot implement a fix` };
      }
      return { snapshot, refusal: "" };
    };
    for (const pipelineId of [configured, candidateId, "managed-fix"]) {
      if (pipelineId === undefined || pipelineId.trim().length === 0) continue;
      const attempt = await validate(pipelineId.trim());
      if (attempt.snapshot !== undefined) return attempt.snapshot;
    }
    throw new Error(
      "Bachata refused this fix: no workflow with write authority could be resolved. Select a fix workflow, or set bachata.fixPipelineId to one.",
    );
  };

  const startScopedFix = async (identity: string): Promise<void> => {
    const source = findSummary(state.activeConversationId);
    const repositoryRoot = await ensureCanonicalRepositoryRoot(
      conversationRepositoryRoot(source),
    );
    const service = longitudinalFor(repositoryRoot);
    const initiative = service.currentInitiative();
    if (initiative === undefined) {
      throw new Error("State the initiative goal before starting a fix");
    }
    const finding = service
      .snapshot()
      .findings.find((entry) => entry.identity === identity);
    if (finding === undefined) {
      throw new Error(`Bachata refused this fix: no finding is tracked as ${identity}`);
    }
    if (!findingIsActionable(finding)) {
      throw new Error(
        "Bachata refused this fix: only an actionable accepted finding can be handed to a bounded fix",
      );
    }
    const openCycle = service.currentCycle();
    if (openCycle === undefined || openCycle.completion !== "open") {
      throw new Error(
        "Bachata refused this fix: this initiative has no open cycle, so the fix result could not be recorded against the finding. Start a fresh review first.",
      );
    }
    const snapshot = await scopedFixSnapshot(source.id, source.selectedPipelineId);
    const prompt = scopedFixPrompt(finding, initiative);
    const created = await createConversation({
      title: `Fix · ${finding.subject}`,
      input: prompt,
      pipelineSnapshot: snapshot,
      ...(source.workingDirectory === undefined
        ? {}
        : { workingDirectory: source.workingDirectory }),
      ...(snapshot.scopeRoot === undefined ? {} : { pipelineScopeRoot: snapshot.scopeRoot }),
    });
    await ensureRuntime(created.id);
    try {
      await runConversation(created.id, prompt, [], undefined, {
        composerAuthorized: true,
        pipelineSnapshot: snapshot,
        requirePipelineHash: snapshot.hash,
        onAccepted: () => {
          const open = service.currentCycle();
          const bound = open === undefined || open.completion !== "open"
            ? undefined
            : service.bindRun({ runRef: created.runRef, cycleId: open.id, freshReview: false });
          if (bound === undefined) {
            reportLongitudinalFailure(
              `The fix run ${created.runRef} was not bound to an open cycle, so ${identity} was left unchanged`,
              repositoryRoot,
            );
            return;
          }
          const linked = service.linkFixRun({ identity, runRef: created.runRef });
          if (!linked.ok) {
            reportLongitudinalFailure(
              `The fix run ${created.runRef} was not bound to ${identity}: ${linked.reason}`,
              repositoryRoot,
            );
          }
        },
      });
    } finally {
      emitSnapshot();
    }
  };

  const startFreshReview = async (cycleType?: CycleType): Promise<void> => {
    const source = findSummary(state.activeConversationId);
    const repositoryRoot = await ensureCanonicalRepositoryRoot(conversationRepositoryRoot(source));
    const service = longitudinalFor(repositoryRoot);
    const initiative = service.currentInitiative();
    if (initiative === undefined) {
      throw new Error("State the initiative goal before starting a fresh review");
    }
    const snapshot = await freshReviewSnapshot(source.id, source.selectedPipelineId);
    const baseline = await refreshBaseline(repositoryRoot);
    const created = await createConversation({
      title: `Fresh review · ${initiative.title}`,
      input: freshReviewPrompt(initiative),
      pipelineSnapshot: snapshot,
      ...(source.workingDirectory === undefined
        ? {}
        : { workingDirectory: source.workingDirectory }),
      ...(snapshot.scopeRoot === undefined
        ? {}
        : { pipelineScopeRoot: snapshot.scopeRoot }),
    });
    await ensureRuntime(created.id);
    try {
      await runConversation(created.id, freshReviewPrompt(initiative), [], undefined, {
        composerAuthorized: true,
        pipelineSnapshot: snapshot,
        requirePipelineHash: snapshot.hash,
        onAccepted: () => {
          const open = service.currentCycle();
          const reusable = open !== undefined &&
            open.completion === "open" &&
            open.type === "review";
          const cycle = reusable
            ? (baseline === undefined ||
                baselineIsSameCandidate(open.repositoryBaseline, baseline)
                ? open
                : service.rebaseline(baseline) ?? open)
            : service.startCycle({
                type: cycleType ?? "review",
                ...(baseline === undefined ? {} : { repositoryBaseline: baseline }),
              });
          if (cycle !== undefined) {
            service.bindRun({ runRef: created.runRef, cycleId: cycle.id, freshReview: true });
          }
        },
      });
    } finally {
      emitSnapshot();
    }
  };

  const runConversation = async (
    conversationId: string,
    prompt: string,
    attachmentIds: string[] = [],
    iterationCount?: number,
    options: ConversationRunOptions = {},
  ): Promise<ConversationExecutionResult> => {
    await ensureInitialized();
    if (conversationExecutionBusy(conversationId)) {
      throw new Error("Conversation execution is already active");
    }
    const releaseRun = claimConversationRun(conversationId);
    try {
      const slot = await ensureRuntime(conversationId);
      const result = await withExecutionLease(conversationId, slot, () =>
        runConversationOwned(
          conversationId,
          prompt,
          attachmentIds,
          iterationCount,
          options,
        )
      );
      if (onboardingObserver) {
        const definition = slot.runtime.getSelectedPipelineSnapshot?.()?.definition;
        onboardingObserver({
          ...journeyOf(conversationId),
          kind: "runCompleted",
          status: result.pipeline.status,
          ...(definition ? { safetyLevel: executionSafetyLevel(definition) } : {}),
          changedFilesRecorded:
            (state.resultsByConversation[conversationId]?.changedFiles.length ?? 0) > 0,
          resolvableFindings: (state.resultsByConversation[conversationId]?.findings ?? [])
            .filter((finding) => finding.disposition !== "rejected").length,
          scopedFix: (() => {
            const summary = state.conversations.find((item) => item.id === conversationId);
            return summary !== undefined && runIsScopedFix(summary);
          })(),
        });
      }
      return result;
    } finally {
      releaseRun();
    }
  };

  const resumeConversation = async (
    conversationId: string,
  ): Promise<ConversationExecutionResult> => {
    await ensureInitialized();
    if (conversationExecutionBusy(conversationId)) {
      throw new Error("Conversation execution is already active");
    }
    const releaseRun = claimConversationRun(conversationId);
    try {
      const slot = await ensureRuntime(conversationId);
      return await withExecutionLease(conversationId, slot, () =>
        resumeConversationOwned(conversationId)
      );
    } finally {
      releaseRun();
    }
  };

  queuedPipelineExecutor = async (conversationId, request, onAccepted): Promise<void> => {
    await activeConversationRunCompletions.get(conversationId);
    const releaseRun = claimConversationRun(conversationId);
    try {
      const slot = await ensureRuntime(conversationId);
      await withExecutionLease(conversationId, slot, async () => {
        const selectedSnapshot = runtimePipelineSnapshot(slot.runtime);
        if (request.pipelineSnapshot && runtimeProvidesPipelineSnapshot(slot.runtime)) {
          if (
            selectedSnapshot?.definition.id !== request.pipelineId ||
            !pipelineSnapshotRootsEqual(selectedSnapshot, request.pipelineSnapshot)
          ) {
            throw new Error("The queued pipeline snapshot is no longer selected in this conversation");
          }
        } else if (slot.runtime.getState().selectedPipelineId !== request.pipelineId) {
          throw new Error("The queued pipeline is no longer selected in this conversation");
        }
        await runConversationOwned(
          conversationId,
          request.prompt,
          request.attachmentIds,
          request.iterationCount,
          {
            onRuntimeAccepted: onAccepted,
            appendPrompt: false,
            sourceQueueMessageId: request.queueMessageId,
            ...(request.iterationMode === undefined ? {} : { iterationMode: request.iterationMode }),
            ...(request.requiredCleanPasses === undefined ? {} : { requiredCleanPasses: request.requiredCleanPasses }),
            ...(request.composerAuthorized ? { composerAuthorized: true } : {}),
            ...(request.pipelineSnapshot
              ? { pipelineSnapshot: request.pipelineSnapshot }
              : {}),
          },
        );
      });
    } finally {
      releaseRun();
    }
  };

  queuedDirectExecutor = async (conversationId, request, onAccepted): Promise<void> => {
    await activeConversationRunCompletions.get(conversationId);
    const releaseRun = claimConversationRun(conversationId);
    try {
      const slot = await ensureRuntime(conversationId);
      await withExecutionLease(conversationId, slot, async () => {
        await onAccepted();
        await slot.runtime.handleMessage({
          type: "message.send",
          recipients: request.recipients,
          prompt: request.prompt,
          mode: request.mode,
          attachmentIds: request.attachmentIds,
          delivery: "immediate",
        });
      }, localRecipientDemand(slot, request.recipients));
    } finally {
      releaseRun();
    }
  };

  const resolveConversationPipelineSnapshot = async (
    conversationId: string,
    pipelineId: string,
    optionsValue: {
      requireCurrentCatalog?: boolean;
      unattended?: boolean;
      rejectChecklist?: boolean;
    } = {},
  ): Promise<PipelineSnapshot> => {
    await ensureInitialized();
    const slot = await ensureRuntime(conversationId);
    return slot.runtime.resolvePipelineSnapshot(pipelineId, optionsValue);
  };

  const resolvePipelineSnapshotInScope = async (
    pipelineScopeRoot: string,
    pipelineId: string,
    optionsValue: {
      requireCurrentCatalog?: boolean;
      unattended?: boolean;
      rejectChecklist?: boolean;
    } = {},
  ): Promise<PipelineSnapshot> => {
    await ensureInitialized();
    const slot = await ensureRuntime(state.activeConversationId);
    return slot.runtime.resolvePipelineSnapshotInScope(
      pipelineScopeRoot,
      pipelineId,
      optionsValue,
    );
  };

  const configureConversationPipelineSnapshot = async (
    conversationId: string,
    pipelineSnapshot: PipelineSnapshot,
  ): Promise<void> => {
    await ensureInitialized();
    if (conversationExecutionBusy(conversationId)) {
      throw new Error("Conversation execution is already active");
    }
    const summary = findSummary(conversationId);
    const slot = await ensureRuntime(conversationId);
    await slot.runtime.configure({
      pipelineId: pipelineSnapshot.definition.id,
      pipelineSnapshot,
    });
    summary.selectedPipelineId = pipelineSnapshot.definition.id;
    summary.selectedPipelineHash = pipelineSnapshot.hash;
    setOptionalProperty(summary, "pipelineScopeRoot", pipelineSnapshot.scopeRoot);
    summary.updatedAt = new Date().toISOString();
    await persist();
    emitSnapshot();
  };

  const interruptConversation = async (conversationId: string): Promise<void> => {
    await ensureInitialized();
    const summary = findSummary(conversationId);
    executionLeaseControllers.get(conversationId)?.abort();
    const slot = await ensureRuntime(conversationId);
    let interruptError: unknown;
    try {
      await bounded(
        slot.runtime.interrupt(),
        Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "managerInterruptTimeoutMs", 15_000)),
        "Runtime interruption",
      );
    } catch (error) {
      interruptError = error;
      const current = executionLeases.get(conversationId);
      if (current) {
        try {
          const reason = `Runtime interruption was not confirmed: ${error instanceof Error ? error.message : String(error)}`;
          const quarantines = await Promise.allSettled(
            executionStateLeases(current).map((lease) =>
              lease.quarantine(reason)
            ),
          );
          const failures = quarantines.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, "Execution resources could not be quarantined");
          }
          executionLeases.delete(conversationId);
        } catch (quarantineError) {
          interruptError = new AggregateError(
            [error, quarantineError],
            "Runtime interruption failed and its execution resources could not be quarantined",
          );
        }
      }
      suspendedExecutionUsers.delete(conversationId);
    } finally {
      catalog.listOpenInteractions(summary.runRef).forEach((interaction) => {
        if (catalog.resolveInteraction(interaction.interactionRef, "cancel", {
          selected: [],
          freeText: "",
        })) {
          resolveInteractionWaiters(interaction.interactionRef, {
            selected: [],
            freeText: "",
            source: "cancel",
          });
        }
      });
      deadlineScheduler.wake();
      emitSnapshot();
    }
    if (interruptError) {
      throw interruptError;
    }
  };

  let initialized = false;
  let initializationInfrastructureReady = false;
  let deletionReconciliationComplete = false;
  let initializationOperation: Promise<void> | undefined;

  const initializeManager = async (): Promise<void> => {
    if (!deletionReconciliationComplete) {
      await reconcileStagedConversationDeletions();
      deletionReconciliationComplete = true;
    }
    if (!initializationInfrastructureReady) {
      state.conversations.forEach((conversation) =>
        claimPersistedBrowserBindings(conversation.id),
      );
      if (vscode.env.remoteName === undefined) {
        try {
          await ensureBrowserBridgeOwnership();
        } catch (error) {
          output.appendLine(
            `Browser Bridge is owned by another VS Code window or quarantined: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      deadlineScheduler.start();
      initializationInfrastructureReady = true;
    }
    await ensureRuntime(state.activeConversationId);
    await warmCanonicalRepositoryRoots();
    await persist();
    initialized = true;
  };

  const ensureInitialized = (): Promise<void> => {
    if (initialized) {
      return Promise.resolve();
    }
    if (initializationOperation) {
      return initializationOperation;
    }
    const operation = initializeManager();
    initializationOperation = operation;
    void operation.finally(() => {
      if (initializationOperation === operation) {
        initializationOperation = undefined;
      }
    }).catch(() => undefined);
    return operation;
  };

  void ensureInitialized().catch((error) => {
    output.appendLine(
      `Conversation manager initialization failed and can be retried: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const handleManagerMutation = async (
    message: Exclude<
      ConversationManagerToExtensionMessage,
      { type: "conversation.runtime" }
    >,
  ): Promise<void> => {
    if (message.type === "manager.ready") {
      emitSnapshot();
      const slot = await ensureRuntime(state.activeConversationId);
      await slot.runtime.handleMessage({ type: "ready" });
      return;
    }
    if (message.type === "initiative.define") {
      const service = await ensureActiveLongitudinal();
      service.defineInitiative({
        title: message.title,
        goal: message.goal,
        ...(message.desiredOutcome === undefined
          ? {}
          : { desiredOutcome: message.desiredOutcome }),
        ...(message.scope === undefined ? {} : { scope: message.scope }),
        ...(message.constraints === undefined ? {} : { constraints: message.constraints }),
        ...(message.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: message.acceptanceCriteria }),
      });
      if (service.currentCycle() === undefined) {
        const baseline = await refreshBaseline(activeRepositoryRoot());
        service.startCycle({
          type: "framing",
          ...(baseline === undefined ? {} : { repositoryBaseline: baseline }),
        });
      }
      emitSnapshot();
      return;
    }
    if (message.type === "initiative.create") {
      const service = await ensureActiveLongitudinal();
      service.createInitiative({
        title: message.title,
        goal: message.goal,
        ...(message.desiredOutcome === undefined
          ? {}
          : { desiredOutcome: message.desiredOutcome }),
        ...(message.scope === undefined ? {} : { scope: message.scope }),
        ...(message.constraints === undefined ? {} : { constraints: message.constraints }),
        ...(message.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: message.acceptanceCriteria }),
      });
      const baseline = await refreshBaseline(activeRepositoryRoot());
      service.startCycle({
        type: "framing",
        ...(baseline === undefined ? {} : { repositoryBaseline: baseline }),
      });
      emitSnapshot();
      return;
    }
    if (message.type === "initiative.switch") {
      if ((await ensureActiveLongitudinal()).switchInitiative(message.initiativeId) === undefined) {
        throw new Error(
          `Bachata refused this switch: no initiative is recorded as ${message.initiativeId} for this repository`,
        );
      }
      emitSnapshot();
      return;
    }
    if (message.type === "initiative.setStatus") {
      const updated = (await ensureActiveLongitudinal()).setInitiativeStatus(
        message.initiativeId,
        message.status,
      );
      if (updated === undefined) {
        throw new Error(
          `Bachata refused this change: no initiative is recorded as ${message.initiativeId} for this repository`,
        );
      }
      emitSnapshot();
      return;
    }
    if (message.type === "initiative.export") {
      const service = await ensureActiveLongitudinal();
      const bundle = service.exportInitiative(message.initiativeId);
      if (bundle === undefined) {
        throw new Error("There is no initiative to export for this repository");
      }
      const repositoryRoot = activeRepositoryRoot();
      const policyLoad = repositoryRoot
        ? await loadExportPolicy(repositoryRoot)
        : { present: false, errors: [] as string[] };
      const filtered = excludeBundlePaths(bundle, policyLoad.policy);
      const leakedPaths: string[] = [];
      const policyApplied = applyExportPolicyToSchema(
        filtered.value,
        INITIATIVE_BUNDLE_SPEC,
        policyLoad.policy,
        (leaked) => {
          if (!leakedPaths.includes(leaked)) leakedPaths.push(leaked);
        },
      );
      const originalArtifacts = new Map(
        bundle.artifacts.map((artifact) => [artifact.id, artifact]),
      );
      const sanitizedArtifacts = policyApplied.value.artifacts.map((artifact) => {
        const original = originalArtifacts.get(artifact.id);
        const digestedContentChanged = original === undefined || (
          original.title !== artifact.title ||
          original.body !== artifact.body ||
          JSON.stringify(original.evidence) !== JSON.stringify(artifact.evidence)
        );
        if (!digestedContentChanged) return artifact;
        const { contentDigest: _digest, ...withoutDigest } = artifact;
        return withoutDigest;
      });
      policyApplied.value = { ...policyApplied.value, artifacts: sanitizedArtifacts };
      if (policyApplied.unclassified.length > 0) {
        throw new Error(
          `Bachata refused this export: it cannot classify ${policyApplied.unclassified.slice(0, 5).join(", ")} as structure or as free text, so it will not guess whether to redact them.`,
        );
      }
      const content = `${JSON.stringify(policyApplied.value, undefined, 2)}\n`;
      const reparsed = parseInitiativeBundle(JSON.parse(content) as unknown);
      if (reparsed.bundle === undefined) {
        throw new Error(
          `Bachata refused this export: redaction produced a bundle it could not read back. ${reparsed.errors.slice(0, 3).join("; ")}`,
        );
      }
      const rules = exportDisclosureRules({
        policy: policyLoad.policy,
        policyErrors: policyLoad.errors,
        excluded: filtered.excluded.length,
        literals: policyApplied.applied,
      });
      const preview = await vscode.workspace.openTextDocument({
        content,
        language: "json",
      });
      await vscode.window.showTextDocument(preview, { preview: true });
      const confirmation = await vscode.window.showWarningMessage(
        `Export the initiative "${bundle.initiative.title}"?`,
        {
          modal: true,
          detail: exportConfirmationDetail({
            content,
            rules,
            contents: `Contents: ${String(bundle.cycles.length)} cycles, ${String(bundle.findings.length)} findings, ${String(bundle.decisions.length)} decisions, ${String(bundle.artifacts.length)} artifacts.`,
          }),
        },
        "Save export",
      );
      if (confirmation !== "Save export") {
        output.appendLine(`Initiative export cancelled after preview: ${bundle.initiative.id}`);
        return;
      }
      const selected = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(
          repositoryRoot ?? storageRoot,
          `${bundle.initiative.id}.initiative.json`,
        )),
        filters: { "Bachata initiative": ["json"] },
        saveLabel: "Export initiative",
      });
      if (!selected) return;
      await vscode.workspace.fs.writeFile(selected, Buffer.from(content, "utf8"));
      output.appendLine(`Exported initiative ${bundle.initiative.id}: ${selected.toString()}`);
      return;
    }
    if (message.type === "initiative.import") {
      const service = await ensureActiveLongitudinal();
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Bachata initiative": ["json"] },
        openLabel: "Import initiative",
      });
      const file = picked?.[0];
      if (!file) return;
      const raw = await vscode.workspace.fs.readFile(file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
      } catch (error) {
        throw new Error(
          `Bachata could not read that file as JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const outcome = service.importInitiative(parsed);
      if (!outcome.ok) {
        throw new Error(`Bachata refused this import: ${outcome.reason}`);
      }
      output.appendLine(
        `Imported initiative ${outcome.initiative.id} as a new initiative. No history was merged.`,
      );
      emitSnapshot();
      return;
    }
    if (message.type === "initiative.setDirection") {
      const directionOutcome = (await ensureActiveLongitudinal()).setDirection(
        message.direction,
        message.rationale === undefined && message.supportingDecisionIds === undefined &&
          message.evidence === undefined
          ? undefined
          : {
            ...(message.rationale === undefined ? {} : { rationale: message.rationale }),
            ...(message.supportingDecisionIds === undefined
              ? {}
              : { supportingDecisionIds: message.supportingDecisionIds }),
            ...(message.evidence === undefined ? {} : { evidence: message.evidence }),
          },
      );
      if (directionOutcome === undefined) {
        throw new Error("State the initiative goal before recording an accepted direction");
      }
      emitSnapshot();
      return;
    }
    if (message.type === "cycle.start") {
      const service = await ensureActiveLongitudinal();
      const baseline = await refreshBaseline(activeRepositoryRoot());
      if (service.startCycle({
        type: message.cycleType,
        ...(message.customType === undefined ? {} : { customType: message.customType }),
        ...(baseline === undefined ? {} : { repositoryBaseline: baseline }),
      }) === undefined) {
        throw new Error("State the initiative goal before starting a cycle");
      }
      emitSnapshot();
      return;
    }
    if (message.type === "cycle.rebaseline") {
      const service = await ensureActiveLongitudinal();
      const baseline = await refreshBaseline(activeRepositoryRoot());
      if (baseline === undefined) {
        throw new Error(
          "Bachata cannot rebaseline this cycle: the working directory is not inside a Git repository",
        );
      }
      if (service.rebaseline(baseline) === undefined) {
        throw new Error("There is no cycle to rebaseline");
      }
      emitSnapshot();
      return;
    }
    if (message.type === "cycle.close") {
      if ((await ensureActiveLongitudinal()).closeCycle(message.nextCycleTrigger) === undefined) {
        throw new Error("There is no open cycle to close");
      }
      onboardingObserver?.({ kind: "nextActionChosen", ...journeyOf(state.activeConversationId) });
      emitSnapshot();
      return;
    }
    if (message.type === "finding.merge") {
      const outcome = (await ensureActiveLongitudinal()).mergeFindings({
        absorbedIdentity: message.absorbedIdentity,
        canonicalIdentity: message.canonicalIdentity,
        reason: message.reason,
        resolvedBy: "human",
      });
      if (!outcome.ok) {
        throw new Error(`Bachata refused this merge: ${outcome.reason}`);
      }
      emitSnapshot();
      return;
    }
    if (message.type === "finding.unmerge") {
      const outcome = (await ensureActiveLongitudinal()).unmergeFinding(message.aliasIdentity);
      if (!outcome.ok) {
        throw new Error(`Bachata refused this unmerge: ${outcome.reason}`);
      }
      emitSnapshot();
      return;
    }
    if (message.type === "finding.startFix") {
      await startScopedFix(message.identity);
      return;
    }
    if (message.type === "notifications.markAllRead") {
      notifications.markAllRead();
      emitSnapshot();
      return;
    }
    if (message.type === "notifications.clear") {
      notifications.clear();
      emitSnapshot();
      return;
    }
    if (message.type === "notifications.setMode") {
      notifications.setMode(message.mode);
      await vscode.workspace
        .getConfiguration("bachata")
        .update("notificationMode", message.mode, vscode.ConfigurationTarget.Global);
      emitSnapshot();
      return;
    }
    if (message.type === "notifications.open") {
      const entry = notifications.find(message.id);
      notifications.markRead(message.id);
      const target = entry?.target;
      if (target?.type === "direction") {
        post({ type: "manager.focusDirection", section: target.section });
        emitSnapshot();
        return;
      }
      if (target?.type === "conversation") {
        await handleMessage({ type: "conversation.select", conversationId: target.conversationId });
        return;
      }
      emitSnapshot();
      return;
    }
    if (message.type === "direction.runNextAction") {
      const baseline = cachedBaseline(activeRepositoryRoot());
      const command = activeLongitudinal().summary(
        baseline === undefined ? {} : { currentBaseline: baseline },
      ).direction.nextAction.command;
      if (command.type === "startScopedFix") {
        await startScopedFix(command.identity);
        return;
      }
      if (command.type === "freshReview") {
        await startFreshReview();
        return;
      }
      if (command.type === "rebaseline") {
        await handleMessage({ type: "cycle.rebaseline" });
        return;
      }
      if (command.type === "closeCycle") {
        await handleMessage({ type: "cycle.close" });
        return;
      }
      if (command.type === "runRequiredChecks") {
        const baselineNow = cachedBaseline(activeRepositoryRoot());
        const verification = activeLongitudinal().summary(
          baselineNow === undefined ? {} : { currentBaseline: baselineNow },
        ).direction.verification;
        if (verification === undefined) {
          throw new Error(
            "Bachata cannot rerun the required checks: this cycle has no recorded check to rerun. Run a workflow that records verification first.",
          );
        }
        const owner = state.conversations.find(
          (item) => item.runRef === verification.runRef,
        );
        if (owner === undefined) {
          throw new Error(
            `Bachata cannot rerun the required checks: the run that recorded them (${verification.runRef}) is not open in this window.`,
          );
        }
        const runId = state.resultsByConversation[owner.id]?.retainedRunId;
        if (runId === undefined) {
          throw new Error(
            `Bachata cannot rerun the required checks: run ${verification.runRef} kept no retained work to recheck.`,
          );
        }
        await handleMessage({
          type: "orchestration.recheck",
          conversationId: owner.id,
          runId,
        });
        return;
      }
      if (command.type === "startCycle") {
        await handleMessage({ type: "cycle.start", cycleType: "review" });
        return;
      }
      post({ type: "manager.focusDirection", section: command.section });
      return;
    }
    if (message.type === "review.startFresh") {
      await startFreshReview(message.cycleType);
      return;
    }
    if (message.type === "resolution.apply") {
      const applied = (await ensureActiveLongitudinal()).resolve({
        target: message.target,
        id: message.id,
        action: message.action,
        resolvedBy: "human",
        ...(message.reason === undefined ? {} : { reason: message.reason }),
        ...(message.supersededById === undefined
          ? {}
          : { supersededById: message.supersededById }),
        ...(message.materialEvidenceDelta === undefined
          ? {}
          : { materialEvidenceDelta: message.materialEvidenceDelta }),
      });
      if (!applied) {
        throw new Error(
          `Bachata refused this resolution: no ${message.target} is recorded as ${message.id}, or the resolution is missing a required reason, material evidence delta, or valid replacement`,
        );
      }
      onboardingObserver?.({ kind: "resolutionRecorded", ...journeyOf(state.activeConversationId) });
      emitSnapshot();
      return;
    }
    if (message.type === "history.openRun") {
      // A semantic record names the run that produced it. Opening that run is how the
      // record's full provenance is reached without reconstructing it from a transcript.
      const summary = state.conversations.find((entry) => entry.runRef === message.runRef);
      if (!summary) {
        output.appendLine(`No run in this workspace carries the reference ${message.runRef}.`);
        return;
      }
      await handleMessage({ type: "conversation.select", conversationId: summary.id });
      return;
    }
    if (message.type === "history.search") {
      const query = message.query.trim();
      const conversationIds: string[] = [];
      let remaining = historySearchBudgetBytes;
      let truncated = false;
      for (const summary of state.conversations) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const scan = (values: unknown[], maxBytes: number): boolean => {
          const result = historyScan(query, values, Math.min(maxBytes, remaining));
          remaining -= result.used;
          if (result.truncated) truncated = true;
          return result.matched;
        };
        const runtime = runtimes.get(summary.id)?.runtime;
        const transcript = runtime
          ? await runtime.loadTranscript()
          : await createTranscriptStore(runtimeStorage(summary.id).storageDirectory, () => undefined).load();
        const matches = scan([
          summary.title,
          summary.input,
          summary.runRef,
          summary.orchestrationTaskId,
        ], 262_144) ||
          scan(transcript, 2_097_152) ||
          scan(catalog.listEvents(summary.runRef, 5_000), 1_048_576) ||
          scan(catalog.listStructuredOutputs(summary.runRef), 1_048_576) ||
          scan(catalog.listInteractions(summary.runRef), 524_288) ||
          scan([state.resultsByConversation[summary.id]], 524_288);
        if (matches) conversationIds.push(summary.id);
      }
      post({
        type: "manager.historyResults",
        requestId: message.requestId,
        conversationIds,
        ...(truncated ? { truncated: true } : {}),
      });
      return;
    }
    if (message.type === "conversation.create") {
      await createConversation();
      return;
    }
    if (message.type === "conversation.duplicate") {
      await duplicateConversation(message.conversationId);
      return;
    }
    if (message.type === "conversation.archive") {
      await archiveConversation(message.conversationId, message.archived);
      return;
    }
    if (message.type === "conversation.select") {
      const summary = findSummary(message.conversationId);
      await ensureCanonicalRepositoryRoot(conversationRepositoryRoot(summary));
      const slot = await ensureRuntime(summary.id);
      await slot.runtime.handleMessage({ type: "ready" });
      const nextConversations = structuredClone(state.conversations);
      const nextSummary = nextConversations.find((item) => item.id === summary.id);
      if (!nextSummary) {
        throw new Error(`Unknown conversation: ${summary.id}`);
      }
      nextSummary.unread = 0;
      nextSummary.updatedAt = new Date().toISOString();
      await persistManagerState(nextConversations, summary.id);
      state.conversations = nextConversations;
      state.activeConversationId = summary.id;
      emitSnapshot();
      return;
    }
    if (message.type === "conversation.saveDraft") {
      const summary = findSummary(message.conversationId);
      if (summary.archived) return;
      const text = message.text.trim().length === 0 ? undefined : message.text;
      if (summary.preparedDraft === text) return;
      setOptionalProperty(summary, "preparedDraft", text);
      await persist();
      return;
    }
    if (message.type === "conversation.consumePreparedDraft") {
      await clearPreparedDraft(message.conversationId);
      return;
    }
    if (
      message.type === "conversation.exportBundle" ||
      message.type === "conversation.openChanges" ||
      message.type === "conversation.openSourceControl"
    ) {
      onboardingObserver?.({ kind: "evidenceReviewed", ...journeyOf(message.conversationId) });
    }
    if (message.type === "conversation.viewExecution") {
      const summary = state.conversations.find((entry) => entry.id === message.conversationId);
      if (summary?.workflowStatus === "completed") {
        onboardingObserver?.({ kind: "evidenceReviewed", ...journeyOf(message.conversationId) });
      }
      return;
    }
    if (message.type === "conversation.exportBundle") {
      const summary = findSummary(message.conversationId);
      const slot = await ensureRuntime(summary.id);
      const runtimeState = slot.runtime.getState();
      const transcript = await slot.runtime.loadTranscript();
      const events = catalog.listEvents(summary.runRef, 5_000);
      const policyLoad = summary.workingDirectory
        ? await loadExportPolicy(summary.workingDirectory)
        : { present: false, errors: [] as string[] };
      const conversationResult = state.resultsByConversation[summary.id];
      const evidenceExclusion = conversationResult
        ? excludeEvidencePaths(conversationResult, policyLoad.policy)
        : undefined;
      const bundleSections = excludeBundlePaths({
        schema: "bachata.run-bundle.v1",
        run: summary,
        result: evidenceExclusion?.result,
        pipelineSnapshot: slot.runtime.getSelectedPipelineSnapshot(),
        transcript,
        events,
        structuredOutputs: catalog.listStructuredOutputs(summary.runRef),
        interactions: catalog.listInteractions(summary.runRef),
        iterations: catalog.listIterations(summary.runRef),
        chats: catalog.listChats(summary.runRef).map((chat) => ({
          chatRef: chat.chatRef,
          agentId: chat.agentId,
          role: chat.role,
          provider: chat.provider,
          adapter: chat.adapter,
          displayTitle: chat.displayTitle,
          status: chat.status,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
        })),
        runSettings: runSettingsByRun.get(summary.runRef),
        replaySourceSettings: replaySourceSettings.get(summary.runRef),
        rejectedRunSettings: runSettingRejections.get(summary.runRef),
        attachments: runtimeState.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
        })),
        orchestration: summary.orchestrationRunId || summary.id === state.orchestration.parentConversationId
          ? state.orchestration
          : undefined,
        omissions: exportOmissions,
      }, policyLoad.policy);
      const excludedFiles = Array.from(new Set([
        ...excludedByPolicy(conversationResult?.changedFiles ?? [], policyLoad.policy),
        ...(evidenceExclusion?.excludedPaths ?? []),
        ...bundleSections.excluded,
      ]));
      const bundle = createRunBundle({
        ...bundleSections.value,
        omissions: [
          ...exportOmissions,
          ...(excludedFiles.length > 0
            ? [`${String(excludedFiles.length)} paths were excluded from every bundle section by ${EXPORT_POLICY_PATH}.`]
            : []),
        ],
      }, new Date().toISOString(), 16_777_216);
      const pipelineName = slot.runtime.getSelectedPipelineSnapshot?.()?.definition.name;
      const maskMetadata = (value: string): string =>
        maskExcludedPaths(value, policyLoad.policy);
      const evidenceInput: EvidenceReportInput | undefined = evidenceExclusion
        ? {
            title: maskMetadata(summary.title),
            runRef: summary.runRef,
            exportedAt: new Date().toISOString(),
            toolVersion: extensionVersion,
            ...(summary.workingDirectory
              ? { workingDirectory: maskMetadata(summary.workingDirectory) }
              : {}),
            ...(pipelineName === undefined ? {} : { pipelineName: maskMetadata(pipelineName) }),
            result: evidenceExclusion.result,
            omissions: [
              ...exportOmissions,
              ...evidenceExclusionOmissions(evidenceExclusion, EXPORT_POLICY_PATH),
            ],
          }
        : undefined;
      const planned = runExportPlan({
        format: message.format,
        hasEvidence: evidenceInput !== undefined,
        runRef: summary.runRef,
      });
      if (planned.refusal !== undefined) {
        throw new Error(planned.refusal);
      }
      const { plan } = planned;
      const rendered = plan.render === "bundle" || evidenceInput === undefined
        ? bundle
        : plan.render === "markdown"
          ? renderEvidenceMarkdown(evidenceInput)
          : renderEvidenceSarif(evidenceInput);
      const leakedPaths: string[] = [];
      const sanitised = maskExcludedPaths(rendered, policyLoad.policy, (path) => {
        if (!leakedPaths.includes(path)) leakedPaths.push(path);
      });
      const policyApplied = applyExportPolicy(sanitised, policyLoad.policy);
      const content = plan.reseal ? resealRunBundle(policyApplied.content) : policyApplied.content;
      const rules = exportDisclosureRules({
        policy: policyLoad.policy,
        policyErrors: policyLoad.errors,
        excluded: 0,
        literals: policyApplied.applied,
      });
      const preview = await vscode.workspace.openTextDocument({
        content,
        language: plan.language,
      });
      await vscode.window.showTextDocument(preview, { preview: true });
      const confirmation = await vscode.window.showWarningMessage(
        plan.prompt,
        { modal: true, detail: exportConfirmationDetail({ content, rules }) },
        "Save export",
      );
      if (confirmation !== "Save export") {
        output.appendLine(`Export cancelled after preview: ${plan.format}`);
        return;
      }
      const selected = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(summary.workingDirectory ?? storageRoot, plan.fileName)),
        filters: plan.saveFilter,
        saveLabel: plan.saveLabel,
      });
      if (selected) {
        await vscode.workspace.fs.writeFile(selected, Buffer.from(content, "utf8"));
        output.appendLine(`Exported redacted ${plan.format}: ${selected.toString()}`);
      }
      return;
    }
    if (message.type === "conversation.revealFile") {
      const summary = findSummary(message.conversationId);
      const root = summary.workingDirectory;
      if (!root) throw new Error("This run has no working directory");
      const candidate = path.isAbsolute(message.path) ? message.path : path.join(root, message.path);
      const [physicalRoot, physicalCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
      if (pathInsideRelative(physicalRoot, physicalCandidate) === undefined) {
        throw new Error("Result file is outside the run working directory");
      }
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(physicalCandidate));
      return;
    }
    if (message.type === "conversation.openChanges") {
      const summary = findSummary(message.conversationId);
      const root = summary.workingDirectory;
      if (!root) throw new Error("This run has no working directory");
      const candidate = path.isAbsolute(message.path) ? message.path : path.join(root, message.path);
      const [physicalRoot, physicalCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
      if (pathInsideRelative(physicalRoot, physicalCandidate) === undefined) {
        throw new Error("Result file is outside the run working directory");
      }
      const target = vscode.Uri.file(physicalCandidate);
      try {
        await vscode.commands.executeCommand("git.openChange", target);
      } catch {
        await vscode.commands.executeCommand("vscode.open", target);
      }
      return;
    }
    if (message.type === "conversation.openSourceControl") {
      findSummary(message.conversationId);
      await vscode.commands.executeCommand("workbench.view.scm");
      return;
    }
    if (message.type === "conversation.publishFindings") {
      findSummary(message.conversationId);
      await vscode.commands.executeCommand("bachata.publishFindings");
      return;
    }
    if (message.type === "conversation.close") {
      await removeConversation(message.conversationId);
      return;
    }
    if (message.type === "conversation.rename") {
      const summary = findSummary(message.conversationId);
      if (summary.archived) {
        throw new Error("Archived conversations are read-only");
      }
      const nextConversations = structuredClone(state.conversations);
      const nextSummary = nextConversations.find(
        (item) => item.id === summary.id,
      );
      if (!nextSummary) {
        throw new Error(`Unknown conversation: ${summary.id}`);
      }
      nextSummary.title = formatRunTitle(nextSummary.runRef, message.title);
      nextSummary.updatedAt = new Date().toISOString();
      await persistManagerState(nextConversations, state.activeConversationId);
      state.conversations = nextConversations;
      emitSnapshot();
      return;
    }
    if (
      message.type === "orchestration.start" ||
      message.type === "orchestration.resume"
    ) {
      if (!todoOrchestrator) {
        throw new Error("TODO orchestration is unavailable");
      }
      const operation = message.type === "orchestration.start"
        ? todoOrchestrator.start()
        : todoOrchestrator.resume();
      void operation.catch((error) => {
        post({
          type: "manager.error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      emitSnapshot();
      return;
    }
    if (message.type === "orchestration.stop") {
      if (!todoOrchestrator) {
        throw new Error("TODO orchestration is unavailable");
      }
      await todoOrchestrator.stop();
      emitSnapshot();
      return;
    }
    if (message.type === "orchestration.abandon") {
      if (!todoOrchestrator) {
        throw new Error("TODO orchestration is unavailable");
      }
      await todoOrchestrator.abandon();
      emitSnapshot();
      return;
    }
    if (message.type === "orchestration.cleanup") {
      if (!todoOrchestrator) {
        throw new Error("TODO orchestration is unavailable");
      }
      await todoOrchestrator.cleanupRetained(message.runId);
      emitSnapshot();
      return;
    }
    if (
      message.type === "orchestration.patch" ||
      message.type === "orchestration.apply" ||
      message.type === "orchestration.recheck" ||
      message.type === "orchestration.diff"
    ) {
      if (!message.conversationId) {
        throw new Error(
          `${message.type} requires the conversation whose run result is displayed`,
        );
      }
      assertRunResultOwnsRun(message.conversationId, message.runId);
    }
    if (message.type === "orchestration.reveal" && message.conversationId) {
      assertRunResultOwnsRun(message.conversationId, message.runId);
    }
    if (message.type === "orchestration.diff") {
      if (!todoOrchestrator?.retainedRunPatchFiles) {
        throw new Error("Hunk selection is unavailable for this run");
      }
      const bounded = boundPatchFiles(
        await todoOrchestrator.retainedRunPatchFiles(message.runId),
      );
      post({
        type: "manager.runDiff",
        conversationId: message.conversationId,
        runId: message.runId,
        files: bounded.files,
        ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
      });
      return;
    }
    if (message.type === "orchestration.patch") {
      if (!todoOrchestrator?.retainedRunPatch) {
        throw new Error("Patch export is unavailable for this run");
      }
      const selection = runPatchSelection(message);
      const patch = await todoOrchestrator.retainedRunPatch(message.runId, selection);
      if (patch.trim().length === 0) {
        await vscode.window.showInformationMessage(
          selectionIsEmpty(selection)
            ? "This run changed nothing, so there is no patch to export."
            : "The selected work carries no change from this run, so there is no patch to export.",
        );
        return;
      }
      const preview = await vscode.workspace.openTextDocument({ content: patch, language: "diff" });
      await vscode.window.showTextDocument(preview, { preview: true });
      const selected = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(storageRoot, `${message.runId}.patch`)),
        filters: { "Git patch": ["patch", "diff"] },
        saveLabel: "Export patch",
      });
      if (selected) {
        await vscode.workspace.fs.writeFile(selected, Buffer.from(patch, "utf8"));
        output.appendLine(`Exported run patch: ${selected.toString()}`);
      }
      return;
    }
    if (message.type === "orchestration.apply") {
      if (!todoOrchestrator?.applyRetained) {
        throw new Error("Applying a retained run is unavailable");
      }
      const boundResult = state.resultsByConversation[message.conversationId];
      const selection = runPatchSelection(message);
      const verdict = applyConfirmationPolicy({
        ...(boundResult?.applyBlockedReason === undefined ? {} : { blockedReason: boundResult.applyBlockedReason }),
        ...(boundResult?.applyOverrideReason === undefined ? {} : { overrideReason: boundResult.applyOverrideReason }),
        selection,
        hasSelectionVerifier: Boolean(todoOrchestrator.verifyRetainedSelection),
      });
      if (verdict.kind === "blocked") {
        output.appendLine(verdict.logLine);
        await vscode.window.showWarningMessage(verdict.message, { modal: true, detail: verdict.detail });
        return;
      }
      if (verdict.kind === "unverifiablePartial") {
        await vscode.window.showWarningMessage(verdict.message, { modal: true, detail: verdict.detail });
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        verdict.question,
        { modal: true, detail: verdict.detail },
        verdict.confirmAction,
      );
      if (confirmation !== verdict.confirmAction) return;
      if (verdict.needsVerification && todoOrchestrator.verifyRetainedSelection) {
        output.appendLine(`Verifying the selected work before applying run ${message.runId}`);
        const selectionChecks = await todoOrchestrator.verifyRetainedSelection(
          message.runId,
          selection,
        );
        selectionChecks.forEach((check) => {
          output.appendLine(`selection check ${check.command}: ${check.status}`);
        });
        const notice = applySelectionUnprovenNotice({
          unproven: selectionChecks.filter((check) => check.status !== "passed"),
        });
        if (notice) {
          await vscode.window.showWarningMessage(notice.message, { modal: true, detail: notice.detail });
          return;
        }
      }
      const result = await todoOrchestrator.applyRetained(message.runId, selection);
      if (!result.applied) {
        output.appendLine(`Run apply refused: ${result.reason ?? "unknown reason"}`);
        await vscode.window.showWarningMessage(
          `This run was not applied: ${result.reason ?? "unknown reason."}`,
          {
            modal: true,
            detail: result.conflicts.length > 0
              ? `Conflicting paths: ${result.conflicts.slice(0, 20).join(", ")}\n\nThe run worktree was kept so nothing is lost.`
              : "The run worktree was kept so nothing is lost.",
          },
        );
        return;
      }
      const overrideReason = boundResult?.applyOverrideReason;
      output.appendLine(
        `Applied run ${message.runId} to ${result.targetBranch}: ${String(result.stagedFiles.length)} staged files${overrideReason ? ` (override: ${overrideReason})` : ""}`,
      );
      if (recordAppliedFix(message.conversationId, {
        stagedFiles: result.stagedFiles,
        targetBranch: result.targetBranch,
      })) {
        onboardingObserver?.({ kind: "workApplied", ...journeyOf(message.conversationId) });
      }
      emitSnapshot();
      const next = await vscode.window.showInformationMessage(
        `Staged ${String(result.stagedFiles.length)} file${result.stagedFiles.length === 1 ? "" : "s"} on ${result.targetBranch}. Nothing was committed.`,
        "Open Source Control",
      );
      if (next === "Open Source Control") {
        await vscode.commands.executeCommand("workbench.view.scm");
      }
      return;
    }
    if (message.type === "readiness.remediate") {
      await vscode.commands.executeCommand("bachata.remediate", {
        remediationId: message.remediationId,
        ...(message.detail === undefined ? {} : { detail: message.detail }),
      });
      return;
    }
    if (message.type === "settings.open") {
      await vscode.commands.executeCommand("workbench.action.openSettings", message.setting);
      return;
    }
    // EX-UI-01. The recovery choices Bachata already knows, as the commands they name. Neither
    // re-runs the failed work.
    if (message.type === "recovery.doctor") {
      await vscode.commands.executeCommand("bachata.doctor");
      return;
    }
    if (message.type === "recovery.setup") {
      await vscode.commands.executeCommand("bachata.setup");
      return;
    }
    if (message.type === "orchestration.recheck") {
      if (!todoOrchestrator?.rerunRetainedChecks) {
        throw new Error("Rechecking a retained run is unavailable");
      }
      const results = await todoOrchestrator.rerunRetainedChecks(message.runId);
      if (results.length === 0) {
        await vscode.window.showInformationMessage("This run declared no final verification to rerun.");
        return;
      }
      results.forEach((result) => {
        output.appendLine(`recheck ${result.command}: ${result.status}`);
      });
      await recordRetainedRecheck(message.conversationId, message.runId, results);
      const failed = results.filter((result) => result.status !== "passed");
      if (failed.length === 0) {
        await vscode.window.showInformationMessage(
          `Reran ${String(results.length)} check${results.length === 1 ? "" : "s"}; all passed.`,
        );
        return;
      }
      await vscode.window.showWarningMessage(
        `Reran ${String(results.length)} check${results.length === 1 ? "" : "s"}; ${String(failed.length)} did not pass.`,
        {
          modal: true,
          detail: failed
            .map((result) => `${result.command}: ${result.status}\n${(result.stderr || result.stdout || "").slice(0, 2_000)}`)
            .join("\n\n"),
        },
      );
      return;
    }
    if (message.type === "orchestration.reveal") {
      if (!todoOrchestrator) {
        throw new Error("TODO orchestration is unavailable");
      }
      const worktree = await todoOrchestrator.resolveRetainedWorktree(message.runId);
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(worktree));
      return;
    }
    if (message.type === "interaction.pause") {
      assertInteractionWritable(message.interactionRef);
      catalog.pauseInteraction(message.interactionRef, "user");
      deadlineScheduler.wake();
      emitSnapshot();
      return;
    }
    if (message.type === "interaction.resume") {
      assertInteractionWritable(message.interactionRef);
      catalog.resumeInteraction(message.interactionRef);
      deadlineScheduler.wake();
      emitSnapshot();
      return;
    }
    if (message.type === "interaction.update") {
      const interaction = assertInteractionWritable(message.interactionRef);
      const contextValue = isRecord(interaction?.context) ? interaction.context : {};
      catalog.updateInteractionDraft(message.interactionRef, {
        ...(message.selected === undefined ? {} : { selected: message.selected }),
        freeText: contextValue.secret === true ? undefined : message.freeText,
        pauseReason: "userEngaged",
      });
      deadlineScheduler.wake();
      emitSnapshot();
      return;
    }
    if (message.type === "interaction.submit") {
      const before = assertInteractionWritable(message.interactionRef);
      if (before.status === "resolved" || before.status === "cancelled") {
        return;
      }
      const contextValue = isRecord(before.context) ? before.context : {};
      const selected = validateInteractionSubmission(before, message.selected, message.freeText);
      const storedFreeText = contextValue.secret === true ? "" : message.freeText;
      catalog.updateInteractionDraft(message.interactionRef, {
        selected,
        freeText: contextValue.secret === true ? undefined : message.freeText,
        pauseReason: "userEngaged",
      });
      if (!catalog.resolveInteraction(message.interactionRef, "user", {
        selected,
        ...(storedFreeText === undefined ? {} : { freeText: storedFreeText }),
        secretProvided: contextValue.secret === true && message.freeText.length > 0,
      })) {
        return;
      }
      resolveInteractionWaiters(message.interactionRef, {
        selected,
        // The waiter contract always carries the text, empty when there was none.
        freeText: message.freeText ?? "",
        source: "user",
      });
      const interaction = catalog.getInteraction(message.interactionRef);
      if (interaction) {
        catalog.appendEvent({
          runRef: interaction.runRef,
          stepRef: interaction.stepRef,
          type: "interaction.resolved",
          status: "completed",
          title: interaction.prompt,
        });
      }
      deadlineScheduler.wake();
      emitSnapshot();
      return;
    }
  };

  const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const guarded = async (): Promise<T> => {
      assertWorkspaceLease();
      return operation();
    };
    const next = mutationQueue.then(guarded, guarded);
    mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const handleRuntimeMessage = async (
    message: Extract<
      ConversationManagerToExtensionMessage,
      { type: "conversation.runtime" }
    >,
  ): Promise<void> => {
    assertWorkspaceLease();
    const summary = findSummary(message.conversationId);
    const archivedReadOnlyMessages = new Set<WebviewToExtensionMessage["type"]>([
      "ready",
      "transcript.loadOlder",
      "transcript.export",
    ]);
    if (summary.archived && !archivedReadOnlyMessages.has(message.message.type)) {
      throw new Error("Archived conversations are read-only");
    }
    activeRuntimeMessages.set(
      message.conversationId,
      (activeRuntimeMessages.get(message.conversationId) ?? 0) + 1,
    );
    const managerOwnedOperation =
      (message.message.type === "pipeline.run" && message.message.delivery !== "queue") ||
      message.message.type === "message.send" ||
      message.message.type === "availability.check" ||
      message.message.type === "workflow.resume";
    try {
      if (message.message.type === "run.interrupt") {
        await interruptConversation(message.conversationId);
        return;
      }
      if (message.message.type === "bridge.discover" || message.message.type === "bridge.reset") {
        await ensureBrowserBridgeOwnership();
      }
      if (message.message.type === "pipeline.run" && message.message.delivery === "immediate") {
        const runMessage = message.message;
        const composerRefusal = (await ensureRuntime(message.conversationId))
          .runtime.pipelineRunRefusal?.();
        if (composerRefusal) {
          throw new Error(composerRefusal);
        }
        await runConversation(
          message.conversationId,
          runMessage.prompt,
          runMessage.attachmentIds,
          runMessage.iterationCount,
          {
            composerAuthorized: true,
            ...(runMessage.iterationMode === undefined ? {} : { iterationMode: runMessage.iterationMode }),
            ...(runMessage.requiredCleanPasses === undefined ? {} : { requiredCleanPasses: runMessage.requiredCleanPasses }),
            onAccepted: () => {
              if (!runMessage.requestId) {
                return;
              }
              post({
                type: "conversation.message",
                conversationId: message.conversationId,
                message: {
                  type: "operation.result",
                  requestId: runMessage.requestId,
                  operation: "pipeline.run",
                  status: "accepted",
                },
              });
            },
          },
        );
        return;
      }
      if (message.message.type === "workflow.resume") {
        await resumeConversation(message.conversationId);
        return;
      }
      const slot = await ensureRuntime(message.conversationId);
      const requiresExecutionLease =
        message.message.type === "message.send" ||
        message.message.type === "availability.check" ||
        (message.message.type === "pipeline.run" && message.message.delivery !== "queue");
      if (requiresExecutionLease) {
        const requestedDemand = message.message.type === "message.send"
          ? localRecipientDemand(slot, message.message.recipients)
          : message.message.type === "availability.check"
            ? availabilityLocalAgentDemand(slot)
          : undefined;
        await withExecutionLease(
          message.conversationId,
          slot,
          () => slot.runtime.handleMessage(message.message),
          requestedDemand,
        );
      } else {
        await slot.runtime.handleMessage(message.message);
      }
    } catch (error) {
      const runtimeState = managerOwnedOperation
        ? undefined
        : runtimes
            .get(message.conversationId)
            ?.runtime.getState();
      if (runtimeState) {
        const running =
          runtimeState.running ||
          Object.values(runtimeState.agents).some(
            (agent) => agent.status === "running",
          );
        const changed =
          summary.running !== running ||
          summary.workflowStatus !== runtimeState.workflowStatus ||
          summary.selectedPipelineId !== runtimeState.selectedPipelineId ||
          summary.workingDirectory !== runtimeState.workingDirectory;
        if (changed) {
          summary.running = running;
          summary.workflowStatus = runtimeState.workflowStatus;
          setOptionalProperty(summary, "selectedPipelineId", runtimeState.selectedPipelineId);
          setOptionalProperty(summary, "workingDirectory", runtimeState.workingDirectory);
          if (
            summary.workflowStatus === "error" &&
            state.activeConversationId !== message.conversationId
          ) {
            summary.unread += 1;
          }
          summary.updatedAt = new Date().toISOString();
          await persist();
          emitSnapshot();
        }
      }
      throw error;
    } finally {
      const remaining =
        (activeRuntimeMessages.get(message.conversationId) ?? 1) - 1;
      if (remaining <= 0) {
        activeRuntimeMessages.delete(message.conversationId);
      } else {
        activeRuntimeMessages.set(message.conversationId, remaining);
      }
    }
  };

  const handleMessage = async (raw: unknown): Promise<void> => {
    if (disposed) {
      throw new Error("Bachata conversation manager is disposed");
    }
    await ensureInitialized();
    assertWorkspaceLease();
    const message = parseManagerMessage(raw);
    if (message.type === "diagnostics.revealOutput") {
      output.show(true);
      return;
    }
    if (message.type === "conversation.runtime") {
      const operation = handleRuntimeMessage(message);
      runtimeOperations.add(operation);
      try {
        await operation;
      } finally {
        runtimeOperations.delete(operation);
      }
      return;
    }
    await enqueueMutation(() => handleManagerMutation(message));
  };

  const attachWebview = (webview: vscode.Webview): vscode.Disposable => {
    webviews.add(webview);
    runtimes.forEach((slot, conversationId) => attachProxy(conversationId, slot));
    void ensureInitialized().then(
      () => {
        emitSnapshot();
        void ensureRuntime(state.activeConversationId)
          .then((slot) => slot.runtime.handleMessage({ type: "ready" }))
          .catch((error) => {
            post({
              type: "manager.error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
      },
      (error) => {
        post({
          type: "manager.error",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return new vscode.Disposable(() => {
      webviews.delete(webview);
      if (webviews.size === 0) {
        detachProxies();
      }
    });
  };

  return {
    handleMessage,
    attachWebview,
    getState: () => structuredClone(state),
    createConversation: (options) => enqueueMutation(() => createConversation(options)),
    // Setup creates a run and waits for a prompt. A review command then reuses that exact
    // run instead of leaving it empty beside a second one.
    adoptIdleConversation: async (conversationId, preparedDraft, title, workingDirectory) => {
      const summary = state.conversations.find((entry) => entry.id === conversationId);
      if (!summary || summary.archived) return false;
      // A run belongs to the repository it was created for. In a multi-root workspace the
      // stored id alone is not enough to prove this is the right one.
      if (workingDirectory !== undefined && summary.workingDirectory !== workingDirectory) {
        return false;
      }
      if (summary.workflowStatus !== "idle") return false;
      if (catalog.listIterations(summary.runRef).length > 0) return false;
      summary.preparedDraft = preparedDraft;
      summary.title = title;
      await persist();
      emitSnapshot();
      return true;
    },
    // Asked before a draft opens, so an initiative-required workflow states its need then
    // rather than refusing after the human has written a whole prompt.
    pipelineRequiresInitiative: (pipelineId) => enqueueMutation(async () => {
      await ensureInitialized();
      const slot = await ensureRuntime(state.activeConversationId);
      return slot.runtime.pipelineRequiresInitiative(pipelineId);
    }),
    hasInitiative: (workingDirectory) =>
      longitudinalFor(workingDirectory ?? defaultRepositoryRoot()).currentInitiative() !== undefined,
    defineInitiative: ({ title, goal, workingDirectory }) => {
      longitudinalFor(workingDirectory ?? defaultRepositoryRoot()).defineInitiative({ title, goal });
    },
    recordExternalEvidence: ({ workingDirectory, ...input }) => {
      const recorded = longitudinalFor(workingDirectory ?? defaultRepositoryRoot())
        .recordExternalEvidence(input);
      if (recorded !== undefined) emitSnapshot();
      return recorded;
    },
    inspectActiveReadiness: (pipelineIds) => enqueueMutation(async () => {
      await ensureInitialized();
      const slot = await ensureRuntime(state.activeConversationId);
      return slot.runtime.inspectReadiness(pipelineIds);
    }),
    resolvePipelineSnapshot: resolveConversationPipelineSnapshot,
    resolvePipelineSnapshotInScope,
    configurePipelineSnapshot: configureConversationPipelineSnapshot,
    runConversation,
    interruptConversation,
    archiveConversation: (conversationId, archived) =>
      enqueueMutation(() => archiveConversation(conversationId, archived)),
    closeConversation: (conversationId) =>
      enqueueMutation(() => removeConversation(conversationId)),
    flush: async () => {
      await ensureInitialized();
      await mutationQueue;
      await Promise.all(Array.from(runtimes.values(), (slot) => slot.runtime.flush()));
      await Promise.all(Array.from(runtimeOperations));
      await persist();
      await persistQueue;
    },
    setChecklistExecutor: (executor, preflight) => {
      checklistExecutor = executor;
      checklistPreflight = preflight;
    },
    setOnboardingObserver: (observer) => {
      onboardingObserver = observer;
    },
    setTodoOrchestrator: (orchestrator) => {
      todoOrchestratorSubscription?.dispose();
      todoOrchestratorSubscription = undefined;
      todoOrchestrator = orchestrator;
      state.orchestration = orchestrator
        ? summarizeOrchestration(orchestrator.getSnapshot())
        : emptyOrchestrationSummary();
      if (orchestrator) {
        todoOrchestratorSubscription = orchestrator.onDidChange((snapshot) => {
          state.orchestration = summarizeOrchestration(snapshot);
          const targetId = snapshot.run?.parentConversationId ?? snapshot.run?.masterConversationId;
          if (
            snapshot.run?.runId &&
            snapshot.run.runId !== lastFocusedOrchestrationRunId &&
            targetId
          ) {
            const target = state.conversations.find(
              (conversation) => conversation.id === targetId && !conversation.archived,
            );
            if (target) {
              lastFocusedOrchestrationRunId = snapshot.run.runId;
              state.activeConversationId = target.id;
              target.unread = 0;
            }
          }
          emitSnapshot();
          void persist().catch((error) => {
            output.appendLine(
              `Failed to persist orchestration state: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        });
      }
      emitSnapshot();
    },
    dispose: () => {
      if (disposeOperation) {
        return disposeOperation;
      }
      disposed = true;
      disposeOperation = (async () => {
        const timeoutMs = Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "managerDisposeTimeoutMs", 30_000));
        const failures: unknown[] = [];
        const capture = async (operation: () => Promise<void>): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            failures.push(error);
          }
        };
        const settle = async (
          operations: Iterable<Promise<unknown>>,
          label: string,
        ): Promise<void> => {
          let results: PromiseSettledResult<unknown>[];
          try {
            results = await bounded(Promise.allSettled(operations), timeoutMs, label);
          } catch (error) {
            failures.push(error);
            return;
          }
          results.forEach((result) => {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          });
        };

        options.workspaceLease?.signal.removeEventListener("abort", handleWorkspaceLeaseLost);
        browserSelectorHealingConfigurationSubscription.dispose();
        if (pipelineCatalogRefreshTimer) {
          clearTimeout(pipelineCatalogRefreshTimer);
          pipelineCatalogRefreshTimer = undefined;
        }
        pipelineWorkspaceFolderSubscription?.dispose();
        disposePipelineCatalogWatchers();
        executionLeaseControllers.forEach((value) => value.abort());
        await capture(() => bounded(initializationOperation ?? Promise.resolve(), timeoutMs, "Manager initialization shutdown"));
        await capture(() => bounded(mutationQueue, timeoutMs, "Manager mutation shutdown"));
        detachProxies();
        await settle(
          Array.from(runtimes.values(), (slot) =>
            bounded(slot.runtime.dispose(), timeoutMs, "Runtime disposal")),
          "Runtime disposal shutdown",
        );
        await settle(Array.from(runtimeOperations), "Runtime operation shutdown");
        await settle(
          Array.from(executionLeaseAcquisitions.values()),
          "Execution acquisition shutdown",
        );
        const quarantineReason = "Conversation manager disposed before execution cleanup was confirmed";
        await settle(
          Array.from(executionLeases.values()).flatMap((state) =>
            executionStateLeases(state).map((lease) =>
              lease.quarantine(quarantineReason)
            )
          ),
          "Execution resource quarantine",
        );
        executionLeases.clear();
        suspendedExecutionUsers.clear();
        executionLeaseAcquisitions.clear();
        executionLeaseControllers.clear();
        executionLeaseMutationQueues.clear();
        runtimes.clear();
        activeRuntimeMessages.clear();
        pendingWorkingDirectories.clear();
        deadlineScheduler.dispose();
        todoOrchestratorSubscription?.dispose();
        todoOrchestratorSubscription = undefined;
        todoOrchestrator = undefined;
        interactionWaiters.forEach((waiters) =>
          waiters.forEach((resolve) =>
            resolve({ selected: [], freeText: "", source: "cancel" }),
          ),
        );
        interactionWaiters.clear();
        if (browserBridgeStartOperation) {
          await capture(() => bounded(
            browserBridgeStartOperation as Promise<void>,
            timeoutMs,
            "Browser Bridge startup shutdown",
          ));
        }
        if (browserBridgeLease) {
          const lease = browserBridgeLease;
          try {
            await bounded(
              sharedBridge.close(),
              Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => configuration.get(settingKey, settingFallback), "browserBridgeCloseTimeoutMs", 10_000)),
              "Browser Bridge shutdown",
            );
            await lease.release();
          } catch (error) {
            try {
              await lease.quarantine(
                `Browser Bridge shutdown was not confirmed: ${error instanceof Error ? error.message : String(error)}`,
              );
            } catch (quarantineError) {
              failures.push(new AggregateError(
                [error, quarantineError],
                "Browser Bridge shutdown failed and ownership could not be quarantined",
              ));
            }
            if (!failures.some((failure) => failure === error || (failure instanceof AggregateError && failure.errors.includes(error)))) {
              failures.push(error);
            }
          } finally {
            if (browserBridgeLease === lease) {
              browserBridgeLease = undefined;
            }
          }
        } else {
          await capture(() => bounded(sharedBridge.close(), timeoutMs, "Browser Bridge shutdown"));
        }
        if (!options.workspaceLease || options.workspaceLease.isValid()) {
          await capture(() => bounded(persist(), timeoutMs, "Manager state persistence"));
          await capture(() => bounded(persistQueue, timeoutMs, "Manager persistence queue"));
        }
        try {
          catalog.close();
        } catch (error) {
          failures.push(error);
        }
        webviews.clear();
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `Conversation manager cleanup was not fully confirmed: ${failures
              .map((failure) => failure instanceof Error ? failure.message : String(failure))
              .join("; ")}`,
          );
        }
      })();
      return disposeOperation;
    },
  };
};
