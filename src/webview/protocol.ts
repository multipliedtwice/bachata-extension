import { AgentApprovalRequest, AgentId, JsonValue } from "../adapters/types";
import { AttachmentMetadata } from "../attachments/attachmentStore";
import type { NotificationCenterState, NotificationMode } from "../notifications/types";
import type { ProviderConversationLocator } from "../conversations/conversationLocator";
import type { ExportFormat } from "../export/exportPlan";

export type WebviewAttachmentMetadata = AttachmentMetadata & {
  previewUri?: string;
};
import { BrowserBridgeStatus } from "../browser/bridgeServer";
import { BrowserConversationBinding } from "../browser/protocol";
import { PipelineSnapshot } from "../pipeline/identity";
import { HumanGateAction } from "../pipeline/runner";
import { RunParticipant } from "../state/catalog";
import { PipelineDefinition } from "../pipeline/types";
import type { LongitudinalSummary, ResolutionTarget } from "../longitudinal/service";
import type { CycleType, HumanResolutionAction } from "../longitudinal/types";
import { PipelineReadiness } from "../readiness/model";
import type { ExecutionContract } from "../contract/executionContract";
import type { ContractAcknowledgement } from "../contract/authority";
import type { RunResultCenter } from "../results/projectResult";
import type { ReviewCandidate } from "../context/reviewScope";
import type { PatchFileSummary, PatchHunkReference } from "../orchestrator/patchSelection";

export type AgentStatus =
  | "unknown"
  | "available"
  | "idle"
  | "running"
  | "interrupted"
  | "error";

export type InteractionMode = "review" | "implementation";

export type WorkflowStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "interrupted"
  | "error";

export type MessageDelivery = "immediate" | "queue" | "interrupt";

export type EvidenceExportFormat = ExportFormat;

export type RuntimeOperation =
  | "pipeline.run"
  | "pipeline.select"
  | "pipeline.validate"
  | "pipeline.save"
  | "pipeline.delete"
  | "pipeline.import"
  | "pipeline.fork"
  | "pipeline.export";

/**
 * EX-G6-17. The operations an editor request can be waiting on, as a value.
 *
 * A request carries a `requestId` and the editor holds it open until an `operation.result` comes
 * back with that id. A handler that throws before it posts one — `pipeline.fork` refusing an
 * unknown pipeline, or refusing to change a pipeline mid-run — left the request pending for the
 * life of the panel. Naming the set here is what lets the dispatcher answer every one of them.
 */
export const RUNTIME_OPERATIONS: readonly RuntimeOperation[] = [
  "pipeline.run",
  "pipeline.select",
  "pipeline.validate",
  "pipeline.save",
  "pipeline.delete",
  "pipeline.import",
  "pipeline.fork",
  "pipeline.export",
];

export const isRuntimeOperation = (value: unknown): value is RuntimeOperation =>
  typeof value === "string" && (RUNTIME_OPERATIONS as readonly string[]).includes(value);

export type RuntimeOperationStatus =
  | "accepted"
  | "completed"
  | "cancelled"
  | "failed";

export type BrowserActionPolicy = "auto" | "ask" | "disabled";

export type QueuedMessage = {
  id: string;
  kind: "pipeline" | "direct";
  pipelineId?: string;
  pipelineSnapshot?: PipelineSnapshot;
  blockedReason?: string;
  prompt: string;
  recipients: AgentId[];
  mode: InteractionMode;
  attachmentIds: string[];
  iterationCount?: number;
  iterationMode?: "fixed" | "untilClean";
  requiredCleanPasses?: number;
  composerAuthorized?: boolean;
  createdAt: string;
};

export type ResumableWorkflow = {
  pipelineId: string;
  pipelineName: string;
  pipelineHash: string;
  userPrompt: string;
  attachmentIds: string[];
  nextStepIndex: number;
  totalSteps: number;
  updatedAt: string;
  sourceQueueMessageId?: string | undefined;
};

export type TranscriptEntry = {
  id: string;
  kind: "prompt" | "answer" | "interrupted" | "status" | "error" | "event";
  agentId?: AgentId | undefined;
  step?: string | undefined;
  text: string;
  createdAt: string;
  eventType?: string | undefined;
  data?: JsonValue | undefined;
};

export type PendingApproval = AgentApprovalRequest & {
  agentId: AgentId;
};

export type AgentPanelState = {
  id: AgentId;
  name: string;
  adapterType: string;
  status: AgentStatus;
  version?: string | undefined;
  sessionId?: string | undefined;
  browserBinding?: BrowserConversationBinding | undefined;
  output: string;
  error?: string | undefined;
};

export type PipelineSummary = {
  id: string;
  name: string;
  description?: string;
  editable: boolean;
  hash: string;
  scopeKey: string;
  scopeRoot?: string;
};


export type PendingHumanGate = {
  stepId: string;
  stepName: string;
  reason:
    | "beforeStep"
    | "afterStep"
    | "invalidConsensus"
    | "maxConsensusRounds";
  round?: number;
  detail?: string;
  allowedActions: HumanGateAction[];
  rollbackTargets: Array<{ id: string; name: string }>;
};

export type PanelState = {
  taskId: string;
  workspaceRoots: string[];
  workingDirectory?: string;
  trusted: boolean;
  pipelines: PipelineSummary[];
  selectedPipelineId?: string;
  selectedPipelineDefinition?: PipelineDefinition;
  selectedPipelineHash?: string;
  readiness: PipelineReadiness;
  executionContract?: ExecutionContract;
  contractAcknowledgement?: ContractAcknowledgement;
  pipelineScopeKey: string;
  pipelineScopeRoot?: string;
  pipelineMutable: boolean;
  pipelineMutationReason?: string;
  advancedMode: boolean;
  browserActionPolicies: {
    readOnly: BrowserActionPolicy;
    mutation: BrowserActionPolicy;
    destructive: BrowserActionPolicy;
    shell: Exclude<BrowserActionPolicy, "auto">;
  };
  adapterTypes: string[];
  agents: Record<AgentId, AgentPanelState>;
  roles: Record<string, AgentId>;
  running: boolean;
  workflowStatus: WorkflowStatus;
  activeStep?: string;
  activeStepId?: string;
  consensusRound?: number;
  pendingGate?: PendingHumanGate;
  transcript: TranscriptEntry[];
  transcriptTotal: number;
  transcriptHasMore: boolean;
  transcriptWindowSize: number;
  transcriptError?: string;
  approvals: PendingApproval[];
  attachments: WebviewAttachmentMetadata[];
  maxAttachmentBytes: number;
  maxAttachmentCount: number;
  maxAttachmentTotalBytes: number;
  browserBridge: BrowserBridgeStatus;
  queuedMessages: QueuedMessage[];
  queuePaused: boolean;
  resumableWorkflow?: ResumableWorkflow;
};

export type ConversationSummary = {
  id: string;
  runRef: string;
  title: string;
  input?: string | undefined;
  preparedDraft?: string | undefined;
  iterationCount: number;
  activeIteration: number;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  waitingForResources?: boolean | undefined;
  workflowStatus: WorkflowStatus;
  unread: number;
  archived: boolean;
  selectedPipelineId?: string | undefined;
  selectedPipelineHash?: string | undefined;
  // The intent the pipeline declared when this run started. Persisted with the run so a
  // restart keeps the same boundary, and a later pipeline change never rewrites history.
  longitudinalIntent?: "initiativeRequired" | "runLocal" | undefined;
  // Exactly what a delta review read. Persisted with the run so a restart keeps the reviewed
  // candidate and exported evidence can never imply a comprehensive review.
  reviewCandidate?: ReviewCandidate | undefined;
  pipelineScopeRoot?: string | undefined;
  participants?: RunParticipant[] | undefined;
  workingDirectory?: string | undefined;
  parentConversationId?: string | undefined;
  orchestrationRunId?: string | undefined;
  orchestrationTaskId?: string | undefined;
  orchestrationBranch?: string | undefined;
  orchestrationBaseCommit?: string | undefined;
  orchestrationPaths?: string[] | undefined;
};

export type WorkflowEventSummary = {
  id: number;
  type: string;
  status?: string | undefined;
  title?: string | undefined;
  payload?: JsonValue | undefined;
  createdAt: string;
};

export type InteractionSummary = {
  interactionRef: string;
  conversationId: string;
  runRef: string;
  kind: string;
  title?: string | undefined;
  prompt: string;
  options: unknown[];
  allowFreeText: boolean;
  secret: boolean;
  selected: string[];
  freeText: string;
  status: "pending" | "paused" | "resolved" | "cancelled";
  createdAt: string;
  deadlineAt?: string | undefined;
  remainingMs?: number | undefined;
  pauseReason?: string | undefined;
};

export type TodoVerificationSummary = {
  command: string;
  status: "passed" | "failed" | "timedOut" | "cancelled";
  exitCode?: number;
  workingDirectory?: string;
  candidateTree?: string;
  outputReference?: string;
};

export type TodoMasterCheckSummary = {
  phase: "schedule" | "terminal";
  status: "continue" | "deviation";
};

export type TodoTaskSummary = {
  id: string;
  title: string;
  status: string;
  attempts: number;
  conversationId?: string;
  lastError?: string;
  checks: TodoVerificationSummary[];
  summary?: string;
  changedFiles?: string[];
  blockers?: string[];
  worktreePath?: string;
  verifiedAt?: string;
};

export type RetainedTodoRunSummary = {
  runId: string;
  title: string;
  status: "completed" | "cleanupPending";
  integrationBranch: string;
  integrationWorktree: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
};

export type TodoOrchestrationSummary = {
  active: boolean;
  runId?: string;
  title?: string;
  status?: string;
  integrationBranch?: string;
  integrationWorktree?: string;
  parentConversationId?: string;
  masterConversationId?: string;
  masterChecks: TodoMasterCheckSummary[];
  tasks: TodoTaskSummary[];
  finalChecks: TodoVerificationSummary[];
  finalChecksVerifiedAt?: string;
  retainedRuns: RetainedTodoRunSummary[];
};

export type LongitudinalDirectionState = LongitudinalSummary;

export type ReadOnlyOwnershipState = {
  owned: false;
  reason: string;
  holderDescription?: string;
  holderLastSeenSecondsAgo?: number;
  retryCommand: string;
};

export type ConversationManagerState = {
  conversations: ConversationSummary[];
  activeConversationId: string;
  defaultPipelineIterations: number;
  maxPipelineIterations: number;
  interactions: InteractionSummary[];
  eventsByConversation: Record<string, WorkflowEventSummary[]>;
  resultsByConversation: Record<string, RunResultCenter>;
  focusedInteractionRef?: string;
  orchestration: TodoOrchestrationSummary;
  direction: LongitudinalDirectionState;
  notifications: NotificationCenterState;
  conversationLocators: Record<string, ProviderConversationLocator[]>;
  /**
   * Present only in a window that did not win workspace ownership. The panel renders the
   * whole product from it and disables every control that would change state, naming the
   * window that owns the repository and how to take ownership.
   */
  readOnly?: ReadOnlyOwnershipState;
};

export type ConversationManagerToExtensionMessage =
  | { type: "manager.ready" }
  | { type: "conversation.create" }
  | { type: "conversation.duplicate"; conversationId: string }
  | { type: "conversation.archive"; conversationId: string; archived: boolean }
  | { type: "conversation.select"; conversationId: string }
  | { type: "conversation.consumePreparedDraft"; conversationId: string }
  | { type: "conversation.saveDraft"; conversationId: string; text: string }
  | { type: "conversation.exportBundle"; conversationId: string; format?: EvidenceExportFormat }
  | { type: "conversation.revealFile"; conversationId: string; path: string }
  | { type: "conversation.openChanges"; conversationId: string; path: string }
  | { type: "conversation.openSourceControl"; conversationId: string }
  | { type: "conversation.viewExecution"; conversationId: string }
  | { type: "conversation.publishFindings"; conversationId: string }
  | { type: "history.search"; query: string; requestId: string }
  | { type: "history.openRun"; runRef: string }
  | {
      type: "initiative.define";
      title: string;
      goal: string;
      desiredOutcome?: string;
      scope?: string[];
      constraints?: string[];
      acceptanceCriteria?: string[];
    }
  | {
      type: "initiative.setDirection";
      direction: string;
      rationale?: string;
      supportingDecisionIds?: string[];
      evidence?: string[];
    }
  | {
      type: "initiative.create";
      title: string;
      goal: string;
      desiredOutcome?: string;
      scope?: string[];
      constraints?: string[];
      acceptanceCriteria?: string[];
    }
  | { type: "initiative.switch"; initiativeId: string }
  | {
      type: "initiative.setStatus";
      initiativeId: string;
      status: "active" | "paused" | "completed" | "abandoned";
    }
  | { type: "initiative.export"; initiativeId?: string }
  | { type: "initiative.import" }
  | { type: "cycle.start"; cycleType: CycleType; customType?: string }
  | { type: "cycle.close"; nextCycleTrigger?: string }
  | { type: "cycle.rebaseline" }
  | { type: "review.startFresh"; cycleType?: CycleType }
  | {
      type: "resolution.apply";
      target: ResolutionTarget;
      id: string;
      action: HumanResolutionAction;
      reason?: string;
      supersededById?: string;
      materialEvidenceDelta?: string[];
    }
  | {
      type: "finding.merge";
      absorbedIdentity: string;
      canonicalIdentity: string;
      reason: string;
    }
  | { type: "finding.unmerge"; aliasIdentity: string }
  | { type: "finding.startFix"; identity: string }
  | { type: "direction.runNextAction" }
  | { type: "notifications.setMode"; mode: NotificationMode }
  | { type: "notifications.markAllRead" }
  | { type: "notifications.clear" }
  | { type: "notifications.open"; id: string }
  | { type: "conversation.close"; conversationId: string }
  | { type: "conversation.rename"; conversationId: string; title: string }
  | { type: "orchestration.start" }
  | { type: "orchestration.resume" }
  | { type: "orchestration.stop" }
  | { type: "orchestration.abandon" }
  | { type: "orchestration.cleanup"; runId: string }
  | { type: "orchestration.reveal"; runId: string; conversationId?: string }
  | {
      type: "orchestration.patch";
      runId: string;
      conversationId: string;
      paths?: string[];
      hunks?: PatchHunkReference[];
    }
  | {
      type: "orchestration.apply";
      runId: string;
      conversationId: string;
      paths?: string[];
      hunks?: PatchHunkReference[];
    }
  | { type: "orchestration.recheck"; runId: string; conversationId: string }
  | { type: "orchestration.diff"; runId: string; conversationId: string }
  | { type: "settings.open"; setting: string }
  /**
   * EX-UI-01. The two recovery choices that are not a setting. Each names one command and carries
   * nothing, so a failure card can offer the choice as a control without the webview being able
   * to ask the extension to run anything else.
   */
  | { type: "recovery.doctor" }
  | { type: "recovery.setup" }
  | { type: "diagnostics.revealOutput" }
  | { type: "readiness.remediate"; remediationId: string; detail?: string }
  | { type: "interaction.pause"; interactionRef: string }
  | { type: "interaction.resume"; interactionRef: string }
  | {
      type: "interaction.update";
      interactionRef: string;
      selected?: string[];
      freeText?: string;
    }
  | {
      type: "interaction.submit";
      interactionRef: string;
      selected: string[];
      freeText: string;
    }
  | {
      type: "conversation.runtime";
      conversationId: string;
      message: WebviewToExtensionMessage;
    };

export type ConversationManagerToWebviewMessage =
  | { type: "manager.snapshot"; state: ConversationManagerState }
  | { type: "manager.focus"; conversationId: string; interactionRef?: string }
  | {
      type: "manager.focusDirection";
      section: "initiative" | "decisions" | "findings";
    }
  | {
      type: "conversation.message";
      conversationId: string;
      message: ExtensionToWebviewMessage;
    }
  | { type: "manager.historyResults"; requestId: string; conversationIds: string[]; truncated?: boolean }
  | {
      type: "manager.runDiff";
      conversationId: string;
      runId: string;
      files: PatchFileSummary[];
      truncated?: string;
    }
  | { type: "manager.error"; message: string };

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "availability.check" }
  | { type: "contract.acknowledge"; fingerprint: string }
  | {
      type: "message.send";
      recipients: AgentId[];
      prompt: string;
      mode: InteractionMode;
      attachmentIds: string[];
      delivery: MessageDelivery;
    }
  | {
      type: "pipeline.run";
      prompt: string;
      attachmentIds: string[];
      delivery: MessageDelivery;
      iterationCount?: number;
      iterationMode?: "fixed" | "untilClean";
      requiredCleanPasses?: number;
      requestId?: string;
    }
  | { type: "pipeline.select"; pipelineId: string; requestId?: string }
  | { type: "pipeline.validate"; pipeline: JsonValue; requestId: string }
  | {
      type: "pipeline.save";
      pipeline: JsonValue;
      mode: "create" | "update";
      scopeKey: string;
      sourcePipelineId?: string;
      expectedHash?: string;
      requestId?: string;
    }
  | {
      type: "pipeline.delete";
      pipelineId: string;
      scopeKey: string;
      expectedHash: string;
      requestId?: string;
    }
  | { type: "pipeline.import"; requestId?: string }
  | { type: "pipeline.fork"; pipelineId: string; requestId?: string }
  | {
      type: "pipeline.export";
      pipelineId?: string;
      pipeline?: JsonValue;
      requestId?: string;
    }
  | { type: "browser.session.select"; agentId: AgentId; sessionId?: string }
  | { type: "browser.asset.save"; assetId: string }
  | { type: "browser.asset.reveal"; assetId: string }
  | { type: "transcript.export" }
  | { type: "queue.cancel"; messageId: string }
  | { type: "queue.resume" }
  | { type: "workflow.resume" }
  | { type: "workflow.discard" }
  | { type: "run.interrupt"; agentId?: AgentId }
  | {
      type: "run.gate";
      action: HumanGateAction;
      targetStepId?: string;
    }
  | { type: "workingDirectory.pick" }
  | { type: "session.reset"; agentId?: AgentId }
  | { type: "task.reset" }
  | { type: "bridge.reset" }
  | { type: "bridge.discover" }
  | { type: "transcript.loadOlder"; beforeId?: string }
  | {
      type: "approval.respond";
      agentId: AgentId;
      requestId: string;
      choiceId: string;
    }
  | {
      type: "attachment.add";
      clientId: string;
      taskId: string;
      name: string;
      mimeType: string;
      dataBase64: string;
    }
  | { type: "attachment.remove"; attachmentId: string };

export type ExtensionToWebviewMessage =
  | { type: "state.snapshot"; state: PanelState }
  | { type: "agent.reset"; agentId: AgentId }
  | { type: "agent.delta"; agentId: AgentId; text: string }
  | { type: "agent.replace"; agentId: AgentId; text: string }
  | {
      type: "agent.patch";
      agentId: AgentId;
      patch: Partial<AgentPanelState>;
    }
  | { type: "transcript.append"; entry: TranscriptEntry }
  | {
      type: "transcript.prepend";
      entries: TranscriptEntry[];
      hasMore: boolean;
      total: number;
    }
  | {
      type: "run.patch";
      running: boolean;
      workflowStatus: WorkflowStatus;
      activeStep?: string;
      activeStepId?: string;
      consensusRound?: number;
      pendingGate?: PendingHumanGate;
      roles?: Record<string, AgentId>;
    }
  | { type: "approval.add"; approval: PendingApproval }
  | { type: "approval.remove"; agentId: AgentId; requestId: string }
  | {
      type: "attachment.added";
      clientId: string;
      attachment: WebviewAttachmentMetadata;
    }
  | { type: "attachment.removed"; attachmentId: string }
  | { type: "attachment.failed"; clientId: string; message: string }
  | { type: "bridge.patch"; status: BrowserBridgeStatus }
  | {
      type: "operation.result";
      requestId: string;
      operation: RuntimeOperation;
      status: RuntimeOperationStatus;
      message?: string;
      pipeline?: PipelineDefinition;
    }
  | { type: "error"; message: string };

export type ParseWebviewMessageResult =
  | { success: true; message: WebviewToExtensionMessage }
  | { success: false; error: string };

type JsonRecord = Record<string, unknown>;

const interactionModes = new Set<InteractionMode>(["review", "implementation"]);
const messageDeliveries = new Set<MessageDelivery>([
  "immediate",
  "queue",
  "interrupt",
]);
const gateActions = new Set<HumanGateAction>([
  "continue",
  "skip",
  "cancel",
  "retry",
  "discardStep",
  "rerunStep",
  "repeatConsensus",
  "requestArbiterRuling",
  "rollback",
]);

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOnlyKeys = (value: JsonRecord, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const reservedIdentifiers = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

const parseIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" &&
  identifierPattern.test(value) &&
  !reservedIdentifiers.has(value)
    ? value
    : undefined;

const parseAgentId = (value: unknown): AgentId | undefined =>
  parseIdentifier(value);

const parsePrompt = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const parseRequestId = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 200
    ? value
    : undefined;

const parseStringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return Array.from(new Set(value));
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

export const parseTranscriptEntry = (
  value: unknown,
): TranscriptEntry | undefined => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    !new Set(["prompt", "answer", "interrupted", "status", "error", "event"]).has(
      value.kind,
    ) ||
    typeof value.text !== "string" ||
    typeof value.createdAt !== "string" ||
    (value.eventType !== undefined && typeof value.eventType !== "string") ||
    (value.data !== undefined && !isJsonValue(value.data))
  ) {
    return undefined;
  }
  const agentId = parseAgentId(value.agentId);
  return {
    id: value.id,
    kind: value.kind as TranscriptEntry["kind"],
    text: value.text,
    createdAt: value.createdAt,
    ...(agentId ? { agentId } : {}),
    ...(typeof value.step === "string" ? { step: value.step } : {}),
    ...(typeof value.eventType === "string"
      ? { eventType: value.eventType }
      : {}),
    ...(value.data !== undefined ? { data: value.data as JsonValue } : {}),
  };
};

const parseMessage = (value: unknown): WebviewToExtensionMessage => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid webview message");
  }

  if (value.type === "transcript.loadOlder") {
    if (!hasOnlyKeys(value, ["type", "beforeId"])) {
      throw new Error("Invalid transcript.loadOlder message");
    }
    if (
      value.beforeId !== undefined &&
      (typeof value.beforeId !== "string" || !value.beforeId.trim())
    ) {
      throw new Error("transcript.loadOlder contains an invalid before id");
    }
    return {
      type: "transcript.loadOlder",
      ...(typeof value.beforeId === "string" ? { beforeId: value.beforeId } : {}),
    };
  }

  if (value.type === "contract.acknowledge") {
    if (!hasOnlyKeys(value, ["type", "fingerprint"]) || typeof value.fingerprint !== "string") {
      throw new Error("Invalid contract.acknowledge message");
    }
    return { type: "contract.acknowledge", fingerprint: value.fingerprint };
  }

  if (
    value.type === "ready" ||
    value.type === "availability.check" ||
    value.type === "workingDirectory.pick" ||
    value.type === "task.reset" ||
    value.type === "bridge.reset" ||
    value.type === "bridge.discover" ||
    value.type === "transcript.export" ||
    value.type === "queue.resume" ||
    value.type === "workflow.resume" ||
    value.type === "workflow.discard"
  ) {
    if (!hasOnlyKeys(value, ["type"])) {
      throw new Error(`Invalid ${value.type} message`);
    }
    return { type: value.type };
  }

  if (value.type === "run.gate") {
    if (!hasOnlyKeys(value, ["type", "action", "targetStepId"])) {
      throw new Error("Invalid run.gate message");
    }
    if (
      typeof value.action !== "string" ||
      !gateActions.has(value.action as HumanGateAction)
    ) {
      throw new Error("run.gate contains an invalid action");
    }
    const targetStepId =
      value.targetStepId === undefined
        ? undefined
        : parseIdentifier(value.targetStepId);
    if (value.targetStepId !== undefined && !targetStepId) {
      throw new Error("run.gate contains an invalid target step");
    }
    return {
      type: "run.gate",
      action: value.action as HumanGateAction,
      ...(targetStepId ? { targetStepId } : {}),
    };
  }

  if (value.type === "message.send") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "recipients",
        "prompt",
        "mode",
        "attachmentIds",
        "delivery",
      ])
    ) {
      throw new Error("Invalid message.send message");
    }
    const recipients = parseStringArray(value.recipients, "recipients");
    if (
      recipients.length === 0 ||
      recipients.some((item) => !parseAgentId(item))
    ) {
      throw new Error("Select at least one valid recipient");
    }
    const prompt = parsePrompt(value.prompt);
    if (!prompt) {
      throw new Error("Prompt cannot be empty");
    }
    if (
      typeof value.mode !== "string" ||
      !interactionModes.has(value.mode as InteractionMode)
    ) {
      throw new Error("message.send contains an invalid interaction mode");
    }
    const delivery = value.delivery ?? "immediate";
    if (
      typeof delivery !== "string" ||
      !messageDeliveries.has(delivery as MessageDelivery)
    ) {
      throw new Error("message.send contains an invalid delivery mode");
    }
    return {
      type: "message.send",
      recipients,
      prompt,
      mode: value.mode as InteractionMode,
      attachmentIds: parseStringArray(value.attachmentIds, "attachmentIds"),
      delivery: delivery as MessageDelivery,
    };
  }

  if (value.type === "pipeline.run") {
    if (!hasOnlyKeys(value, [
      "type",
      "prompt",
      "attachmentIds",
      "delivery",
      "iterationCount",
      "iterationMode",
      "requiredCleanPasses",
      "requestId",
    ])) {
      throw new Error("Invalid pipeline.run message");
    }
    const prompt = parsePrompt(value.prompt);
    if (!prompt) {
      throw new Error("Prompt cannot be empty");
    }
    const delivery = value.delivery ?? "immediate";
    if (
      typeof delivery !== "string" ||
      !messageDeliveries.has(delivery as MessageDelivery)
    ) {
      throw new Error("pipeline.run contains an invalid delivery mode");
    }
    const iterationCount = value.iterationCount === undefined
      ? undefined
      : Number(value.iterationCount);
    if (
      iterationCount !== undefined &&
      (!Number.isSafeInteger(iterationCount) || iterationCount < 1 || iterationCount > 50)
    ) {
      throw new Error("pipeline.run iterationCount must be an integer from 1 to 50");
    }
    const iterationMode = value.iterationMode === undefined ? "fixed" : value.iterationMode;
    if (iterationMode !== "fixed" && iterationMode !== "untilClean") {
      throw new Error("pipeline.run iterationMode must be fixed or untilClean");
    }
    const requiredCleanPasses = value.requiredCleanPasses === undefined
      ? undefined
      : Number(value.requiredCleanPasses);
    if (requiredCleanPasses !== undefined
      && (!Number.isSafeInteger(requiredCleanPasses) || requiredCleanPasses < 1 || requiredCleanPasses > 10)) {
      throw new Error("pipeline.run requiredCleanPasses must be an integer from 1 to 10");
    }
    const requestId = parseRequestId(value.requestId);
    if (value.requestId !== undefined && !requestId) {
      throw new Error("pipeline.run contains an invalid request id");
    }
    return {
      type: "pipeline.run",
      prompt,
      attachmentIds: parseStringArray(value.attachmentIds, "attachmentIds"),
      delivery: delivery as MessageDelivery,
      ...(iterationCount === undefined ? {} : { iterationCount }),
      iterationMode,
      ...(requiredCleanPasses === undefined ? {} : { requiredCleanPasses }),
      ...(requestId ? { requestId } : {}),
    };
  }

  if (value.type === "queue.cancel") {
    if (
      !hasOnlyKeys(value, ["type", "messageId"]) ||
      typeof value.messageId !== "string" ||
      !value.messageId.trim()
    ) {
      throw new Error("queue.cancel requires a message id");
    }
    return { type: "queue.cancel", messageId: value.messageId };
  }

  if (value.type === "pipeline.import") {
    if (!hasOnlyKeys(value, ["type", "requestId"])) {
      throw new Error("pipeline.import does not accept extra fields");
    }
    if (value.requestId !== undefined && !parseRequestId(value.requestId)) {
      throw new Error("pipeline.import contains an invalid request id");
    }
    return {
      type: "pipeline.import",
      ...(value.requestId ? { requestId: value.requestId as string } : {}),
    };
  }

  if (value.type === "pipeline.fork") {
    if (!hasOnlyKeys(value, ["type", "pipelineId", "requestId"])) {
      throw new Error("Invalid pipeline.fork message");
    }
    const pipelineId = parseIdentifier(value.pipelineId);
    if (!pipelineId) throw new Error("pipeline.fork contains an invalid pipeline id");
    const requestId = value.requestId === undefined ? undefined : parseRequestId(value.requestId);
    if (value.requestId !== undefined && !requestId) throw new Error("pipeline.fork contains an invalid request id");
    return { type: "pipeline.fork", pipelineId, ...(requestId ? { requestId } : {}) };
  }

  if (value.type === "pipeline.export") {
    if (!hasOnlyKeys(value, ["type", "pipelineId", "pipeline", "requestId"])) {
      throw new Error("Invalid pipeline.export message");
    }
    const pipelineId = value.pipelineId === undefined
      ? undefined
      : parseIdentifier(value.pipelineId);
    if (value.pipelineId !== undefined && !pipelineId) {
      throw new Error("pipeline.export contains an invalid pipeline id");
    }
    let pipeline: JsonValue | undefined;
    if (value.pipeline !== undefined) {
      if (!isJsonValue(value.pipeline)) {
        throw new Error("pipeline.export contains an invalid pipeline definition");
      }
      pipeline = value.pipeline;
    }
    if (!pipelineId && pipeline === undefined) {
      throw new Error("pipeline.export requires a pipeline id or definition");
    }
    if (value.requestId !== undefined && !parseRequestId(value.requestId)) {
      throw new Error("pipeline.export contains an invalid request id");
    }
    return {
      type: "pipeline.export",
      ...(pipelineId ? { pipelineId } : {}),
      ...(pipeline !== undefined ? { pipeline } : {}),
      ...(value.requestId ? { requestId: value.requestId as string } : {}),
    };
  }

  if (value.type === "pipeline.validate") {
    if (!hasOnlyKeys(value, ["type", "pipeline", "requestId"]) || !isJsonValue(value.pipeline)) {
      throw new Error("pipeline.validate requires a JSON pipeline definition");
    }
    const requestId = parseRequestId(value.requestId);
    if (!requestId) {
      throw new Error("pipeline.validate requires a request id");
    }
    return { type: "pipeline.validate", pipeline: value.pipeline, requestId };
  }

  if (value.type === "pipeline.save") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "pipeline",
        "mode",
        "scopeKey",
        "sourcePipelineId",
        "expectedHash",
        "requestId",
      ]) ||
      !isJsonValue(value.pipeline) ||
      (value.mode !== "create" && value.mode !== "update") ||
      typeof value.scopeKey !== "string" ||
      !value.scopeKey.trim()
    ) {
      throw new Error("pipeline.save requires a JSON pipeline definition and mutation mode");
    }
    const sourcePipelineId = value.sourcePipelineId === undefined
      ? undefined
      : parseIdentifier(value.sourcePipelineId);
    if (value.sourcePipelineId !== undefined && !sourcePipelineId) {
      throw new Error("pipeline.save contains an invalid source pipeline id");
    }
    const expectedHash = typeof value.expectedHash === "string" && /^[0-9a-f]{64}$/u.test(value.expectedHash)
      ? value.expectedHash
      : undefined;
    if (value.expectedHash !== undefined && !expectedHash) {
      throw new Error("pipeline.save contains an invalid expected hash");
    }
    if (value.mode === "create" && (sourcePipelineId || expectedHash)) {
      throw new Error("pipeline.save create does not accept source identity");
    }
    if (value.mode === "update" && (!sourcePipelineId || !expectedHash)) {
      throw new Error("pipeline.save update requires source identity and expected hash");
    }
    const requestId = parseRequestId(value.requestId);
    if (value.requestId !== undefined && !requestId) {
      throw new Error("pipeline.save contains an invalid request id");
    }
    return {
      type: "pipeline.save",
      pipeline: value.pipeline,
      mode: value.mode,
      scopeKey: value.scopeKey,
      ...(sourcePipelineId ? { sourcePipelineId } : {}),
      ...(expectedHash ? { expectedHash } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  if (value.type === "pipeline.delete") {
    if (
      !hasOnlyKeys(value, ["type", "pipelineId", "scopeKey", "expectedHash", "requestId"]) ||
      !parseIdentifier(value.pipelineId) ||
      typeof value.scopeKey !== "string" ||
      !value.scopeKey.trim() ||
      typeof value.expectedHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.expectedHash)
    ) {
      throw new Error("pipeline.delete requires a valid pipeline id and expected hash");
    }
    if (value.requestId !== undefined && !parseRequestId(value.requestId)) {
      throw new Error("pipeline.delete contains an invalid request id");
    }
    return {
      type: "pipeline.delete",
      pipelineId: value.pipelineId as string,
      scopeKey: value.scopeKey,
      expectedHash: value.expectedHash,
      ...(value.requestId ? { requestId: value.requestId as string } : {}),
    };
  }

  if (value.type === "browser.asset.save" || value.type === "browser.asset.reveal") {
    if (
      !hasOnlyKeys(value, ["type", "assetId"]) ||
      typeof value.assetId !== "string" ||
      !value.assetId.trim() ||
      value.assetId.length > 200
    ) {
      throw new Error(`${value.type} contains an invalid asset id`);
    }
    return { type: value.type, assetId: value.assetId };
  }

  if (value.type === "browser.session.select") {
    if (!hasOnlyKeys(value, ["type", "agentId", "sessionId"])) {
      throw new Error("Invalid browser.session.select message");
    }
    const agentId = parseAgentId(value.agentId);
    if (!agentId) {
      throw new Error("browser.session.select contains an invalid agent");
    }
    if (
      value.sessionId !== undefined &&
      (typeof value.sessionId !== "string" || !value.sessionId.trim())
    ) {
      throw new Error("browser.session.select contains an invalid session");
    }
    return {
      type: "browser.session.select",
      agentId,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    };
  }

  if (value.type === "pipeline.select") {
    if (
      !hasOnlyKeys(value, ["type", "pipelineId", "requestId"]) ||
      !parseIdentifier(value.pipelineId)
    ) {
      throw new Error("pipeline.select requires a valid pipeline id");
    }
    if (value.requestId !== undefined && !parseRequestId(value.requestId)) {
      throw new Error("pipeline.select contains an invalid request id");
    }
    return {
      type: "pipeline.select",
      pipelineId: value.pipelineId as string,
      ...(value.requestId ? { requestId: value.requestId as string } : {}),
    };
  }

  if (value.type === "run.interrupt" || value.type === "session.reset") {
    if (!hasOnlyKeys(value, ["type", "agentId"])) {
      throw new Error(`Invalid ${value.type} message`);
    }
    const agentId =
      value.agentId === undefined ? undefined : parseAgentId(value.agentId);
    if (value.agentId !== undefined && !agentId) {
      throw new Error(`${value.type} contains an invalid agent`);
    }
    return { type: value.type, ...(agentId === undefined ? {} : { agentId }) };
  }

  if (value.type === "approval.respond") {
    if (!hasOnlyKeys(value, ["type", "agentId", "requestId", "choiceId"])) {
      throw new Error("Invalid approval.respond message");
    }
    const agentId = parseAgentId(value.agentId);
    if (!agentId) {
      throw new Error("approval.respond contains an invalid agent");
    }
    if (typeof value.requestId !== "string" || !value.requestId.trim()) {
      throw new Error("approval.respond requires a request id");
    }
    if (typeof value.choiceId !== "string" || !value.choiceId.trim()) {
      throw new Error("approval.respond requires a choice id");
    }
    return {
      type: "approval.respond",
      agentId,
      requestId: value.requestId,
      choiceId: value.choiceId,
    };
  }

  if (value.type === "attachment.add") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "clientId",
        "taskId",
        "name",
        "mimeType",
        "dataBase64",
      ]) ||
      typeof value.clientId !== "string" ||
      !value.clientId.trim() ||
      typeof value.taskId !== "string" ||
      !value.taskId.trim() ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      typeof value.mimeType !== "string" ||
      !value.mimeType.trim() ||
      typeof value.dataBase64 !== "string" ||
      !value.dataBase64
    ) {
      throw new Error("attachment.add contains invalid attachment data");
    }
    return {
      type: "attachment.add",
      clientId: value.clientId,
      taskId: value.taskId,
      name: value.name,
      mimeType: value.mimeType,
      dataBase64: value.dataBase64,
    };
  }

  if (value.type === "attachment.remove") {
    if (
      !hasOnlyKeys(value, ["type", "attachmentId"]) ||
      typeof value.attachmentId !== "string" ||
      !value.attachmentId.trim()
    ) {
      throw new Error("attachment.remove requires an attachment id");
    }
    return { type: "attachment.remove", attachmentId: value.attachmentId };
  }

  throw new Error(`Unsupported webview message type: ${value.type}`);
};

export const parseWebviewMessage = (
  value: unknown,
): ParseWebviewMessageResult => {
  try {
    return { success: true, message: parseMessage(value) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
