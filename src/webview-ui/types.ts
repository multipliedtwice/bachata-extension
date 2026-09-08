/**
 * Webview protocol and view-model types.
 *
 * Concatenated first by tsconfig.webview.json (module: none, outFile), so every other
 * webview module sees these declarations without imports. Types only: no runtime value is
 * declared here, which is what makes the ordering safe.
 */

type BachataWebviewBehaviorApi = {
  dialogInitialFocus: (hasInput: boolean, danger: boolean) => "input" | "cancel" | "confirm";
  focusReturnSelector: (element: HTMLElement | null) => string | undefined;
  wrappedFocusIndex: (activeIndex: number, controlCount: number, shiftKey: boolean) => number | undefined;
  shouldSubmitComposer: (targetId: string, key: string, ctrlKey: boolean, metaKey: boolean) => boolean;
};

type AgentId = string;
type AgentStatus =
  | "unknown"
  | "available"
  | "idle"
  | "running"
  | "interrupted"
  | "error";
type InteractionMode = "review" | "implementation";
type WorkflowStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "interrupted"
  | "error";
type MessageDelivery = "immediate" | "queue" | "interrupt";
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type AgentDefinition = {
  id: string;
  name: string;
  adapter: string;
  command?: string;
  model?: string;
  workingDirectory?: string;
  permissionMode?: string;
  approvalPolicy?: "onRequest" | "unlessTrusted";
  resourceId?: string;
  capabilities?: string[];
};
type ConsensusConfig = {
  mode: "unanimous" | "arbiter";
  maxRounds: number;
  candidateField?: string;
  acceptedField?: string;
  objectionsField?: string;
  risksField?: string;
  acceptedValue?: boolean;
  arbiter?: string;
  onMaxRounds?: "humanGate" | "fail" | "requestArbiterRuling";
  resultFormat?: "json";
  resultField?: string;
};
type AgentStep = {
  id: string;
  name: string;
  enabled: boolean;
  humanGate: "none" | "before" | "after" | "both";
  type: "agent";
  participants: string[];
  promptTemplate: string;
  parallel: boolean;
  consensus: boolean;
  consensusConfig?: ConsensusConfig;
  output?: { name: string; format: "json"; schema: JsonValue };
  permissionModes?: Record<string, string>;
  approvalPolicies?: Record<string, "onRequest" | "unlessTrusted">;
  attachments?: "none" | "selected";
  requiredCapabilities?: string[];
};
type RoleStep = {
  id: string;
  name: string;
  enabled: boolean;
  humanGate: "none" | "before" | "after" | "both";
  type: "assignRoles";
  roleAssignments: Array<{ agentId: string; role: string }>;
};
type ChecklistStep = {
  id: string;
  name: string;
  enabled: boolean;
  humanGate: "none" | "before" | "after" | "both";
  type: "checklist";
  participants: string[];
  promptTemplate: string;
  outputName: string;
  timeoutMs?: number;
  permissionModes?: Record<string, string>;
  approvalPolicies?: Record<string, "onRequest" | "unlessTrusted">;
  attachments?: "none" | "selected";
  requiredCapabilities?: string[];
};
type ExecuteChecklistStep = {
  id: string;
  name: string;
  enabled: boolean;
  humanGate: "none" | "before";
  type: "executeChecklist";
  inputName: string;
  pipelineId: string;
  allowedPaths: string[];
  checks: string[];
  checkResources?: string[];
  allowNoChecks?: boolean;
  retries?: number;
  maxConcurrency?: number;
};
type PipelineStep = AgentStep | RoleStep | ChecklistStep | ExecuteChecklistStep;
type RoleDefinition = {
  id: string;
  name: string;
  instructions: string;
  model?: string;
  requiredCapabilities?: string[];
  preferredAdapters?: string[];
  candidateAgentIds?: string[];
  resourceId?: string;
  readOnly?: boolean;
  managed?: boolean;
  managedRole?: "worker" | "lead";
  managedOptional?: boolean;
  readPaths?: string[];
  allowedPaths?: string[];
  protectedPaths?: string[];
  commitMode?: "never" | "allow";
  verificationChecks?: Array<{ id: string; command: string }>;
};
type ManagedPipelinePolicy = {
  readPaths?: string[];
  allowedPaths?: string[];
  protectedPaths?: string[];
  commitMode?: "never" | "allow";
  verificationChecks?: Array<{ id: string; command: string }>;
  maxRevisionCycles?: number;
};
type PipelineDefinition = {
  version: 1;
  id: string;
  name: string;
  description?: string;
  managedPolicy?: ManagedPipelinePolicy;
  agents: AgentDefinition[];
  roles?: RoleDefinition[];
  steps: PipelineStep[];
};
type AgentPanelState = {
  id: string;
  name: string;
  adapterType: string;
  status: AgentStatus;
  version?: string;
  sessionId?: string;
  output: string;
  error?: string;
};
type TranscriptEntry = {
  id: string;
  kind: "prompt" | "answer" | "interrupted" | "status" | "error" | "event";
  agentId?: string;
  step?: string;
  eventType?: string;
  data?: JsonValue;
  text: string;
  createdAt: string;
};
type PendingApproval = {
  agentId: string;
  requestId: string;
  kind: "command" | "fileChange" | "permissions" | "browserAction";
  reason?: string;
  command?: string;
  cwd?: string;
  browserAction?: JsonValue;
  choices: Array<{ id: string; label: string }>;
};
type AttachmentMetadata = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  previewUri?: string;
};
type PipelineSummary = {
  id: string;
  name: string;
  description?: string;
  editable: boolean;
  hash: string;
  scopeKey: string;
  scopeRoot?: string;
};
type BrowserSessionStatus =
  | "disconnected"
  | "notAuthenticated"
  | "notReady"
  | "ready"
  | "submitting"
  | "streaming"
  | "failed";
type BrowserSession = {
  id: string;
  provider: "chatgpt" | "claude" | "generic";
  tabId: number;
  frameId: number;
  documentId?: string;
  documentToken: string;
  conversationUrl: string;
  conversationIdentity: string;
  title?: string;
  status: BrowserSessionStatus;
  capabilities?: {
    submission: "verifiedSend" | "syntheticEnter" | "native";
    completion: "verifiedLifecycle" | "manualOnly" | "native";
    interruption: "confirmed" | "unavailable" | "native";
    assets: "supported" | "textOnly";
    conversationState: "confirmed" | "uncertain";
  };
  createdAt: string;
  updatedAt: string;
};
type BrowserBridgeStatus = {
  enabled: boolean;
  endpoint?: string;
  pairingToken?: string;
  pairingExpiresAt?: string;
  connected: boolean;
  selectedSessionId?: string;
  sessions: BrowserSession[];
  error?: string;
};

const browserProviderForAdapterType = (
  adapterType: string,
): BrowserSession["provider"] | undefined => {
  if (adapterType === "chatgpt-browser") return "chatgpt";
  if (adapterType === "claude-browser") return "claude";
  if (adapterType === "generic-browser") return "generic";
  return undefined;
};

const browserProviderName = (provider: BrowserSession["provider"]): string =>
  provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : "Generic";
type HumanGateAction =
  | "continue"
  | "skip"
  | "cancel"
  | "retry"
  | "discardStep"
  | "rerunStep"
  | "repeatConsensus"
  | "requestArbiterRuling"
  | "rollback";
type PendingHumanGate = {
  stepId: string;
  stepName: string;
  reason: "beforeStep" | "afterStep" | "invalidConsensus" | "maxConsensusRounds";
  round?: number;
  detail?: string;
  allowedActions: HumanGateAction[];
  rollbackTargets: Array<{ id: string; name: string }>;
};
type QueuedMessage = {
  id: string;
  kind: "pipeline" | "direct";
  pipelineId?: string;
  blockedReason?: string;
  prompt: string;
  recipients: string[];
  mode: InteractionMode;
  attachmentIds: string[];
  iterationCount?: number;
  createdAt: string;
};
type ResumableWorkflow = {
  pipelineId: string;
  pipelineName: string;
  pipelineHash: string;
  userPrompt: string;
  attachmentIds: string[];
  nextStepIndex: number;
  totalSteps: number;
  updatedAt: string;
};
type BrowserActionPolicy = "auto" | "ask" | "disabled";
type ExecutionContract = {
  pipelineId: string;
  pipelineName: string;
  safetyLevel: "review" | "interactive" | "managed" | "orchestration";
  providers: Array<{
    agentId: string;
    name: string;
    adapter: string;
    adapterLabel?: string;
    model?: string;
    modelSource?: "configured" | "unreported";
    runtimeVersion?: string;
    runtimeVersionSource?: "detected" | "unreported";
    roles: string[];
    status: "ready" | "blocked" | "needsSetup" | "unsupported";
    detail?: string;
  }>;
  roles: Array<{
    id: string;
    name: string;
    managed: boolean;
    optional: boolean;
    readOnly: boolean;
    writeScope: "task" | "configured" | "workspace" | "readOnly";
    writablePaths: string[];
    readablePaths: string[];
    protectedPaths: string[];
    commitPolicy: "never" | "allow";
    verification: string[];
    candidateAgentIds: string[];
  }>;
  scope: {
    workingDirectory?: string;
    writeScope: "task" | "configured" | "workspace" | "readOnly";
    writablePaths: string[];
    readablePaths: string[];
    protectedPaths: string[];
  };
  commitPolicy: "never" | "allow";
  verification: string[];
  verificationResources: string[];
  humanGates: Array<{ stepId: string; stepName: string; gate: string }>;
  limits: {
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
    participantTurnsBounded?: boolean;
    consensusSteps?: Array<{
      stepId: string;
      stepName: string;
      maxRounds: number;
      roundLimitRetryable: boolean;
    }>;
    executesChecklist?: boolean;
  };
  provenance?: {
    extensionVersion: string;
    pipelineHash: string;
  };
  assurance?: "readOnly" | "unverified" | "modelReviewed" | "controllerVerified" | "isolatedApplicable";
  assuranceLabel?: string;
  assuranceStatement?: string;
  fallbacks: string[];
  completion: string[];
  policyRefusals?: string[];
  blockers: string[];
  outboundContext?: Array<{
    agentId: string;
    name: string;
    adapterLabel: string;
    transport: string;
    entries: Array<{ kind: string; label: string; detail: string; exact: boolean }>;
    exclusions: string[];
    redactions: string[];
  }>;
};

type PanelState = {
  taskId: string;
  workspaceRoots: string[];
  workingDirectory?: string;
  trusted: boolean;
  pipelines: PipelineSummary[];
  selectedPipelineId?: string;
  selectedPipelineDefinition?: PipelineDefinition;
  selectedPipelineHash?: string;
  readiness?: {
    status: "ready" | "blocked" | "needsSetup" | "unsupported";
    findings: Array<{
      id: string;
      label: string;
      status: "ready" | "blocked" | "needsSetup" | "unsupported";
      detail: string;
      remediationId?: string;
    }>;
  };
  executionContract?: ExecutionContract;
  contractAcknowledgement?: {
    fingerprint: string;
    open: boolean;
    acknowledgementRequired: boolean;
    diff: {
      expanded: boolean;
      changes: Array<{ label: string; from: string; to: string; expands: boolean }>;
    };
  };
  pipelineScopeKey: string;
  pipelineScopeRoot?: string;
  pipelineMutable: boolean;
  advancedMode: boolean;
  pipelineMutationReason?: string;
  browserActionPolicies: {
    readOnly: BrowserActionPolicy;
    mutation: BrowserActionPolicy;
    destructive: BrowserActionPolicy;
    shell: Exclude<BrowserActionPolicy, "auto">;
  };
  adapterTypes: string[];
  agents: Record<string, AgentPanelState>;
  roles: Record<string, string>;
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
  attachments: AttachmentMetadata[];
  maxAttachmentBytes: number;
  maxAttachmentCount: number;
  maxAttachmentTotalBytes: number;
  browserBridge: BrowserBridgeStatus;
  queuedMessages: QueuedMessage[];
  queuePaused: boolean;
  resumableWorkflow?: ResumableWorkflow;
};
type RunParticipant = {
  name: string;
  adapter: string;
  model?: string;
};
type ConversationSummary = {
  id: string;
  runRef: string;
  title: string;
  input?: string;
  preparedDraft?: string;
  iterationCount: number;
  activeIteration: number;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  waitingForResources?: boolean;
  workflowStatus: WorkflowStatus;
  unread: number;
  archived: boolean;
  selectedPipelineId?: string;
  selectedPipelineHash?: string;
  pipelineScopeRoot?: string;
  participants?: RunParticipant[];
  workingDirectory?: string;
  parentConversationId?: string;
  orchestrationRunId?: string;
  orchestrationTaskId?: string;
};
type WorkflowEventSummary = {
  id: number;
  type: string;
  status?: string;
  title?: string;
  payload?: JsonValue;
  createdAt: string;
};
type InteractionSummary = {
  interactionRef: string;
  conversationId: string;
  runRef: string;
  kind: string;
  title?: string;
  prompt: string;
  options: unknown[];
  allowFreeText: boolean;
  secret: boolean;
  selected: string[];
  freeText: string;
  status: "pending" | "paused" | "resolved" | "cancelled";
  createdAt: string;
  deadlineAt?: string;
  remainingMs?: number;
  pauseReason?: string;
};
type TodoVerificationSummary = {
  command: string;
  status: "passed" | "failed" | "timedOut" | "cancelled";
  stale?: boolean;
  exitCode?: number;
  workingDirectory?: string;
  candidateTree?: string;
  outputReference?: string;
};
type TodoMasterCheckSummary = {
  phase: "schedule" | "terminal";
  status: "continue" | "deviation";
};
type TodoTaskSummary = {
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
};
type RunResultCenter = {
  status: WorkflowStatus;
  changedFiles: string[];
  diffSummary?: string;
  checks: TodoVerificationSummary[];
  finalRuling?: string;
  rulingBy?: string;
  rulingProvenance?: {
    kind:
      | "unanimousConsensus"
      | "arbiterRuling"
      | "singleProvider"
      | "controllerVerification"
      | "humanResolution";
    participants: RulingParticipantIdentity[];
    ruledBy?: string;
    resolvedBy?: string;
  };
  consensusRuling?: boolean;
  providers?: Array<{ name: string; adapter: string; model?: string }>;
  findings?: Array<{
    id: string;
    subject: string;
    message: string;
    disposition: "proposed" | "accepted" | "rejected" | "unresolved";
    severity?: "error" | "warning" | "information";
    location?: { file: string; startLine?: number; endLine?: number };
    evidence: string[];
    challenges: string[];
    provenance: {
      source: "pipelineDecision" | "stepOutput" | "legacyRuling";
      stepId: string;
      participantIds: string[];
      decisionStatus?: "accepted" | "ruled";
      ruledBy?: string;
    };
  }>;
  unresolvedRisks: string[];
  recoveredErrors: string[];
  retainedWorktree?: string;
  retainedRunId?: string;
  executionRef?: string;
  expectations?: { changedFiles: boolean; verification: boolean; finalRuling: boolean };
  evidence?: Array<{
    kind: "changedFiles" | "verification" | "finalRuling" | "rulingProvenance";
    label: string;
    state: "recorded" | "notApplicable" | "missing";
    detail: string;
  }>;
  evidenceGaps: string[];
  finalAssessment?: {
    outcome: "completed" | "verificationFailed" | "inconclusive" | "notApplicable";
    method: "consensus" | "arbiter" | "singleProvider" | "controller" | "none";
    summary: string;
    producedBy: Array<{ name: string; adapter: string; model?: string }>;
  };
  verificationProvenance?: { source: "run" | "recheck"; recordedAt: string };
  applyBlockedReason?: string;
  applyOverrideReason?: string;
};
type RetainedTodoRunSummary = {
  runId: string;
  title: string;
  status: "completed" | "cleanupPending";
  integrationBranch: string;
  integrationWorktree: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
};
type TodoOrchestrationSummary = {
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
  retainedRuns: RetainedTodoRunSummary[];
};
type LongitudinalLifecycleState =
  | "proposed" | "accepted" | "rejected" | "deferred" | "superseded";
type LongitudinalFindingState =
  | "new" | "repeated" | "accepted" | "rejected"
  | "unresolved" | "resolved" | "regressed" | "reopened";
type LongitudinalHumanResolution = {
  action: "accept" | "reject" | "defer" | "supersede" | "reopen";
  resolvedBy: string;
  resolvedAt: string;
  reason?: string;
};
type DirectionFinding = {
  fixState?: "awaitingFix" | "fixRunning" | "fixApplied" | "verified";
  identity: string;
  subject: string;
  message: string;
  state: LongitudinalFindingState;
  location?: { file: string; startLine?: number; endLine?: number };
  occurrences: number;
  actionable: boolean;
  materialDelta: string[];
  evidence: string[];
  challenges: string[];
  humanResolution?: LongitudinalHumanResolution;
  resolutionHistory?: LongitudinalHumanResolution[];
  firstCycleId?: string;
  lastCycleId?: string;
  lastRunRef?: string;
};
type DirectionDecision = {
  id: string;
  revision?: number;
  subject: string;
  question: string;
  state: LongitudinalLifecycleState;
  recommendation?: string;
  tradeOffs: string[];
  evidence: string[];
  affectedScope: string[];
  reopenReason?: string;
  materialEvidenceDelta: string[];
  humanResolution?: LongitudinalHumanResolution;
  resolutionHistory?: LongitudinalHumanResolution[];
  supersededById?: string;
  supersedesId?: string;
  options?: string[];
  producedByRunRef?: string;
};
type DirectionArtifact = {
  id: string;
  title: string;
  body?: string;
  type: string;
  revision: number;
  state: LongitudinalLifecycleState;
  humanResolution?: LongitudinalHumanResolution;
  evidence?: string[];
  producedByRunRef?: string;
};
type DirectionBaseline = {
  commit: string;
  branch?: string;
  dirty: boolean;
  worktreeDigest: string;
  capturedAt: string;
};
type DirectionVerification = {
  runRef: string;
  checks: Array<{ command: string; status: string; stale?: boolean }>;
  expected: boolean;
  recordedAt: string;
  baseline?: DirectionBaseline;
};
type DirectionCycle = {
  id: string;
  sequence: number;
  type: string;
  completion: "open" | "completed" | "abandoned";
  runRefs: string[];
  repositoryBaseline?: DirectionBaseline | string;
  verifications?: DirectionVerification[];
  nextCycleTrigger?: string;
};
type DirectionComparison = {
  cycleId: string;
  newMaterial: DirectionFinding[];
  repeated: DirectionFinding[];
  resolved: DirectionFinding[];
  regressed: DirectionFinding[];
  reopened: DirectionFinding[];
  notObserved?: DirectionFinding[];
  outstandingAccepted: DirectionFinding[];
  decisionChanges: Array<{
    decisionId: string;
    subject: string;
    from?: LongitudinalLifecycleState;
    to: LongitudinalLifecycleState;
    reason?: string;
  }>;
};
type DirectionReconciliationQuestion = {
  freshIdentity: string;
  subject: string;
  kind: "ambiguous" | "split" | "conflict";
  detail: string;
  candidates: Array<{ identity: string; subject: string; score: number }>;
};
type DirectionSaturation = {
  saturated: boolean;
  quietFreshReviews: number;
  quietReviewSignal: number;
  signalReached: boolean;
  reasons: string[];
};
type DirectionSummary = {
  goal?: string;
  desiredOutcome?: string;
  acceptedDirection?: string;
  directionRevisions?: Array<{
    revision: number;
    text: string;
    author: string;
    recordedAt: string;
    rationale?: string;
    supportingDecisionIds?: string[];
    evidence?: string[];
  }>;
  acceptanceCriteria: string[];
  constraints: string[];
  initiativeStatus?: "active" | "paused" | "completed" | "abandoned";
  currentCycle?: {
    id: string;
    sequence: number;
    type: string;
    completion: "open" | "completed" | "abandoned";
    runCount: number;
  };
  baseline?: DirectionBaseline;
  currentBaseline?: DirectionBaseline;
  baselineDrift?: string[];
  verification?: DirectionVerification;
  latestChange?: DirectionComparison;
  acceptedArtifacts: DirectionArtifact[];
  proposedArtifacts: DirectionArtifact[];
  decisionsNeedingHuman: DirectionDecision[];
  findingsNeedingRuling?: DirectionFinding[];
  outstandingAcceptedFindings: DirectionFinding[];
  unresolvedFindings: DirectionFinding[];
  reconciliationQuestions?: DirectionReconciliationQuestion[];
  decisionHistory?: DirectionDecision[];
  findingHistory?: DirectionFinding[];
  saturation: DirectionSaturation;
  saturationDisclaimer: string;
  quietReviewStatement?: string;
  closeCycleAvailable?: boolean;
  nextAction: {
    kind: string;
    label: string;
    detail: string;
    command?: { type: string; section?: string; identity?: string };
  };
};
type ResolutionMatrix = Record<string, Record<string, string[]>>;

type DirectionExternalEvidence = {
  id: string;
  claim: string;
  relation: "supports" | "contradicts" | "qualifies";
  authority: string;
  state: LongitudinalLifecycleState;
  disposition: string;
  revision: number;
  freshnessHorizonDays?: number;
  source: {
    uri: string;
    title: string;
    publisher?: string;
    publishedAt?: string;
    retrievedAt: string;
    contentDigest: string;
  };
  target: {
    kind: "artifact" | "decision" | "finding" | "initiative";
    artifactId?: string;
    decisionId?: string;
    identity?: string;
  };
  challenges: Array<{ text: string; participantIds: string[]; recordedAt: string }>;
  humanResolution?: LongitudinalHumanResolution;
  supersededById?: string;
};

type DirectionFindingAlias = {
  aliasIdentity: string;
  canonicalIdentity: string;
  reason: string;
  createdBy: string;
  createdAt: string;
};
type DirectionInitiative = {
  id: string;
  title: string;
  goal: string;
  status: "active" | "paused" | "completed" | "abandoned";
  updatedAt: string;
};

type LongitudinalState = {
  initiative?: {
    id: string;
    title: string;
    goal: string;
    desiredOutcome: string;
    scope: string[];
    constraints: string[];
    acceptanceCriteria: string[];
    currentDirection?: string;
    status: "active" | "paused" | "completed" | "abandoned";
  };
  initiatives?: DirectionInitiative[];
  cycles: DirectionCycle[];
  currentCycle?: DirectionCycle;
  artifacts: DirectionArtifact[];
  decisions: DirectionDecision[];
  findings: DirectionFinding[];
  findingAliases?: DirectionFindingAlias[];
  externalEvidence?: DirectionExternalEvidence[];
  staleExternalEvidenceIds?: string[];
  staleRuns?: Array<{ runRef: string; cycleId: string; recordedAt: string }>;
  latestComparison?: DirectionComparison;
  saturation: DirectionSaturation;
  resolutionMatrix?: ResolutionMatrix;
  validationErrors?: string[];
  direction: DirectionSummary;
};
type ProviderConversationLocator = {
  chatRef: string;
  agentId: string;
  role: string;
  provider: string;
  adapter: string;
  providerSessionId?: string;
  conversationOrigin?: string;
  createdAt: string;
  lastSeenAt: string;
  reconstruction: "available" | "unavailable" | "unknown";
  reconstructionDetail: string;
};
type NotificationMode = "off" | "decisions" | "material" | "all";
type NotificationEntry = {
  id: string;
  kind: string;
  level: "decision" | "material" | "routine";
  text: string;
  action: "inspect" | "discard" | "restore";
  recordedAt: string;
  read: boolean;
};
type NotificationCenterState = {
  mode: NotificationMode;
  unread: number;
  events: NotificationEntry[];
};
type ManagerState = {
  conversations: ConversationSummary[];
  activeConversationId: string;
  defaultPipelineIterations: number;
  maxPipelineIterations: number;
  interactions: InteractionSummary[];
  eventsByConversation: Record<string, WorkflowEventSummary[]>;
  resultsByConversation: Record<string, RunResultCenter>;
  focusedInteractionRef?: string;
  orchestration: TodoOrchestrationSummary;
  direction: LongitudinalState;
  notifications?: NotificationCenterState;
  conversationLocators?: Record<string, ProviderConversationLocator[]>;
  /** Set only in a window that did not win workspace ownership. */
  readOnly?: ReadOnlyOwnership;
};
type RuntimeMessage =
  | { type: "state.snapshot"; state: PanelState }
  | { type: "agent.reset"; agentId: string }
  | { type: "agent.delta"; agentId: string; text: string }
  | { type: "agent.replace"; agentId: string; text: string }
  | { type: "agent.patch"; agentId: string; patch: Partial<AgentPanelState> }
  | { type: "transcript.append"; entry: TranscriptEntry }
  | { type: "transcript.prepend"; entries: TranscriptEntry[]; total: number; hasMore: boolean }
  | {
      type: "run.patch";
      running: boolean;
      workflowStatus: WorkflowStatus;
      activeStep?: string;
      activeStepId?: string;
      consensusRound?: number;
      pendingGate?: PendingHumanGate;
      roles?: Record<string, string>;
    }
  | { type: "approval.add"; approval: PendingApproval }
  | { type: "approval.remove"; agentId: string; requestId: string }
  | { type: "attachment.added"; clientId: string; attachment: AttachmentMetadata }
  | { type: "attachment.removed"; attachmentId: string }
  | { type: "attachment.failed"; clientId: string; message: string }
  | { type: "bridge.patch"; status: BrowserBridgeStatus }
  | {
      type: "operation.result";
      requestId: string;
      operation: "pipeline.run" | "pipeline.select" | "pipeline.validate" | "pipeline.save" | "pipeline.delete" | "pipeline.import" | "pipeline.fork" | "pipeline.export";
      status: "accepted" | "completed" | "cancelled" | "failed";
      message?: string;
      pipeline?: PipelineDefinition;
    }
  | { type: "error"; message: string };
type HumanE2eAction =
  | "selectRun"
  | "resumeWorkflow"
  | "archiveRun"
  | "unarchiveRun"
  | "deleteRun"
  | "startTodo"
  | "stopTodo"
  | "resumeTodo"
  | "abandonTodo"
  | "cleanupTodo"
  | "discoverBridge"
  | "selectBrowserSession"
  | "submitPreparedRun";
type ExtensionMessage =
  | { type: "humanE2e.uiRun"; requestId: string; prompt: string; iterationCount: number; pipeline: PipelineDefinition; submit: boolean }
  | { type: "humanE2e.uiAction"; requestId: string; action: HumanE2eAction; targetId?: string }
  | { type: "manager.snapshot"; state: ManagerState }
  | { type: "manager.focus"; conversationId: string; interactionRef?: string }
  | { type: "manager.focusDirection"; section: "initiative" | "decisions" | "findings" }
  | { type: "conversation.message"; conversationId: string; message: RuntimeMessage }
  | { type: "manager.historyResults"; requestId: string; conversationIds: string[]; truncated?: boolean }
  | { type: "manager.runDiff"; conversationId: string; runId: string; files: RunPatchFile[]; truncated?: string }
  | { type: "manager.restoreState"; state: PersistedWebviewState }
  | { type: "manager.error"; message: string };
type RunPatchHunk = {
  index: number;
  header: string;
  added: number;
  removed: number;
  preview: string;
};
type RunPatchFile = {
  path: string;
  oldPath?: string;
  binary: boolean;
  renamed: boolean;
  modeChanged?: boolean;
  wholeFileOnly: boolean;
  hunks: RunPatchHunk[];
};
type PendingAttachment = {
  clientId: string;
  name: string;
  size: number;
  previewUrl: string;
};
type ConversationDraft = {
  prompt: string;
  iterationCount: number;
  iterationMode: "fixed" | "untilClean";
  requiredCleanPasses: number;
  delivery: MessageDelivery;
  selectedAttachmentIds: Set<string>;
  pendingAttachments: Map<string, PendingAttachment>;
};
type PendingRunRequest = {
  conversationId: string;
  prompt: string;
  attachmentIds: string[];
  accepted: boolean;
};
type PendingEditorOperation = {
  operation: "pipeline.validate" | "pipeline.save" | "pipeline.delete" | "pipeline.import" | "pipeline.fork" | "pipeline.export";
  requestId: string;
  conversationId: string;
  returnFocusSelector?: string;
};
type AppDialog =
  | { kind: "renameRun"; title: string; message: string; confirmLabel: string; conversationId: string; inputValue: string }
  | { kind: "archiveRun"; title: string; message: string; confirmLabel: string; conversationId: string }
  | { kind: "deleteRun"; title: string; message: string; confirmLabel: string; conversationId: string; danger: true }
  | { kind: "stopOrchestration"; title: string; message: string; confirmLabel: string }
  | { kind: "abandonOrchestration"; title: string; message: string; confirmLabel: string; danger: true }
  | { kind: "resetTask"; title: string; message: string; confirmLabel: string; danger: true }
  | { kind: "resetBridge"; title: string; message: string; confirmLabel: string; danger: true }
  | { kind: "discardEditor"; title: string; message: string; confirmLabel: string; danger: true }
  | { kind: "replaceEditorImport"; title: string; message: string; confirmLabel: string; danger: true }
  | { kind: "deletePipeline"; title: string; message: string; confirmLabel: string; pipelineId: string; scopeKey: string; expectedHash: string; danger: true }
  | { kind: "cleanupRetainedRun"; title: string; message: string; confirmLabel: string; runId: string; danger: true }
  | { kind: "discardWorkflow"; title: string; message: string; confirmLabel: string; danger: true }
  | {
      kind: "resolveRecord";
      title: string;
      message: string;
      confirmLabel: string;
      target: "finding" | "decision" | "artifact" | "externalEvidence";
      recordId: string;
      mode: "reopen" | "supersede";
      inputValue: string;
    }
  | {
      kind: "createInitiative";
      title: string;
      message: string;
      confirmLabel: string;
      inputValue: string;
    }
  | {
      kind: "mergeFinding";
      title: string;
      message: string;
      confirmLabel: string;
      absorbedIdentity: string;
      inputValue: string;
    };
type PersistedEditorDraft = {
  raw: string;
  draft: string;
  mode: "form" | "json";
  originalRaw: string;
  conversationId?: string;
  sourcePipelineId?: string;
  sourcePipelineName?: string;
  sourcePipelineHash?: string;
  scopeKey?: string;
};
type PersistedWebviewState = { drafts?: Record<string, string>; editor?: PersistedEditorDraft };
type VsCodeApi = {
  postMessage: (message: unknown) => void;
  getState?: () => PersistedWebviewState | undefined;
  setState?: (value: PersistedWebviewState) => void;
};
type PrismApi = {
  languages: Record<string, unknown>;
  highlight: (code: string, grammar: unknown, language: string) => string;
};

declare const acquireVsCodeApi: () => VsCodeApi;
declare const Prism: PrismApi;
declare const bachataWebviewBehavior: BachataWebviewBehaviorApi;
