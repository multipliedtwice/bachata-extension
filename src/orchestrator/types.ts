import { PipelineSnapshot } from "../pipeline/identity";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TodoTaskSpec = {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  line: number;
  explicitId: boolean;
  dependsOn: string[];
  pipelineId: string;
  pipelineSnapshot?: PipelineSnapshot;
  paths: string[];
  checks: string[];
  checksDeclared: boolean;
  checkResources?: string[];
  finalChecks?: string[];
  finalChecksDeclared?: boolean;
  finalCheckResources?: string[];
  priority: number;
  retries: number;
};

export type TodoDocument = {
  filePath: string;
  source: string;
  sourceHash: string;
  tasks: TodoTaskSpec[];
};

export type OrchestrationTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "waitingForResources"
  | "verifying"
  | "integrating"
  | "done"
  | "blocked"
  | "failed"
  | "cancelled";

export type VerificationCheckResult = {
  command: string;
  status: "passed" | "failed" | "timedOut" | "cancelled";
  exitCode?: number;
  workingDirectory?: string;
  candidateTree?: string;
  outputReference?: string;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  cleanupConfirmed?: boolean;
};

export type RetainedEvidenceSet = {
  fingerprint: string;
  checks: VerificationCheckResult[];
  /**
   * EX-A5-R01. The receiving branch's HEAD when these checks ran. Absent on evidence recorded
   * before the branch was bound, which is treated as unbound and refuses Apply.
   */
  target?: string;
};

export type SelfImprovementReviewRecord = {
  phase: "review" | "finalReview";
  verdict: "accept" | "reject";
  summary: string;
  defects: Array<{
    id: string;
    severity: "blocker" | "major" | "minor";
    statement: string;
    requiredChange: string;
    evidence: string[];
  }>;
  conversationId: string;
  taskTree: string;
  reviewedAt: string;
};

export type TaskExecutionResult = {
  status: "done" | "blocked" | "failed" | "needsHuman";
  summary: string;
  changedFiles: string[];
  checks: VerificationCheckResult[];
  blockers: string[];
  pipelineStatus?: "completed" | "interrupted";
};

export type OrchestrationTaskState = {
  spec: TodoTaskSpec;
  status: OrchestrationTaskStatus;
  attempts: number;
  conversationId?: string;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
  baseTree?: string;
  commit?: string;
  integrationRollbackCommit?: string;
  /**
   * The run's `acceptedIntegrations` count when the rollback commit above was recorded. A resume
   * that finds a higher count knows another task's integration was accepted after this marker was
   * written, so resetting to it would discard work the run reports as accepted.
   */
  integrationRollbackSequence?: number;
  /**
   * Dependency directories this task's worktree shared with the live repository instead of
   * owning. A command that wrote through one wrote into the person's own checkout: outside the
   * run's isolation, absent from its patch and Apply, and not undone by abandoning the run.
   */
  sharedDependencies?: string[];
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  implementationComplete?: boolean;
  revisionCycles?: number;
  reviews?: SelfImprovementReviewRecord[];
  result?: TaskExecutionResult;
};


export type MasterDeviationKind =
  | "skippedTask"
  | "wrongTask"
  | "missingCompletion"
  | "stalledTask"
  | "retryPolicy"
  | "todoState";

export type MasterDeviation = {
  taskId: string;
  kind: MasterDeviationKind;
  details: string;
};

export type MasterCheck = {
  checkedAt: string;
  phase: "schedule" | "terminal";
  status: "continue" | "deviation";
  deviations: MasterDeviation[];
  conversationId: string;
};

export type OrchestrationRunStatus =
  | "preparing"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "blocked"
  | "failed"
  | "abandoning"
  | "cleanupPending"
  | "abandoned";

export type GeneratedTodoPlan = {
  source: string;
  // What each participant reported reading, kept so the claim that two independent audits
  // happened can be checked after the fact rather than taken on trust.
  audits: Array<{
    agentId: string;
    status: "assessed" | "blocked";
    blockedReason?: string;
    inspected: string[];
    findingCount: number;
  }>;
  candidateId: string;
  candidateHash: string;
  ruling: "accepted" | "ruled";
  discoveryConversationId: string;
  title: string;
  summary: string;
  evidence: string[];
  blockers: Array<{ subject: string; question: string; evidence: string[] }>;
  tasks: Array<{
    id: string;
    outcome: string;
    details: string;
    paths: string[];
    dependsOn: string[];
    checks: string[];
    finalChecks: string[];
    priority: number;
    retries: number;
    evidence: string[];
  }>;
};

export type OrchestrationLedger = {
  version: 1;
  runId: string;
  title: string;
  status: OrchestrationRunStatus;
  workspaceRoot: string;
  ownerWorkspaceRoot?: string;
  sourceKind: "todoFile" | "generatedChecklist";
  mode?: "todo" | "selfImprovement";
  repositoryVerifierAuthority?: "refused" | "humanApproved";
  reviewPipelineId?: string;
  reviewPipelineSnapshot?: PipelineSnapshot;
  revisionPipelineId?: string;
  revisionPipelineSnapshot?: PipelineSnapshot;
  maxRevisionCycles?: number;
  generatedTodo?: GeneratedTodoPlan;
  generatedTodoPath?: string;
  // Non-empty means discovery named a judgment a human owns. The run stops before
  // implementation and Resume refuses it, so a stopped blocker cannot be restarted into work.
  humanDecisionBlockers?: string[];
  todoPath?: string;
  todoSourceHash?: string;
  parentRunRef?: string;
  parentConversationId?: string;
  userNote?: string;
  generatedAllowedPaths?: string[];
  integrationBranch: string;
  integrationWorktree: string;
  baselineCommit: string;
  inputTree?: string;
  sealedInputPaths?: string[];
  integrationTree?: string;
  commitMode?: "never" | "allow";
  createdAt: string;
  updatedAt: string;
  maxConcurrency: number;
  masterConversationId?: string;
  masterPipelineId?: string;
  masterPipelineSnapshot?: PipelineSnapshot;
  masterChecks: MasterCheck[];
  /**
   * How many task integrations this run has accepted. Integration is serialized, so the count a
   * rollback marker was written at orders that marker against every acceptance: a count higher
   * than the marker's names accepted work that resetting to the marker would throw away.
   */
  acceptedIntegrations?: number;
  tasks: Record<string, OrchestrationTaskState>;
  finalChecks: VerificationCheckResult[];
  /**
   * P3. What has been verified about this run's retained candidate, by candidate fingerprint.
   *
   * Apply reads this rather than `finalChecks`: the final checks describe the tree the run
   * finished on, and a retained worktree can move under it. Each entry is bound to the exact
   * candidate — and, for a selective apply, the exact selection — it was produced for.
   */
  retainedEvidence?: RetainedEvidenceSet[];
  finalCheckCommands?: string[];
  finalCheckResources?: string[];
  stopRequestedAt?: string;
  error?: string;
};

export type RetainedOrchestrationRun = {
  runId: string;
  title: string;
  status: "completed" | "cleanupPending";
  integrationBranch: string;
  integrationWorktree: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
};

export type OrchestrationSnapshot = {
  active: boolean;
  run?: OrchestrationLedger;
  retainedRuns: RetainedOrchestrationRun[];
};

export type TaskFailureKind =
  | "cancelled"
  | "providerUnavailable"
  | "timeout"
  | "verificationFailed"
  | "mergeConflict"
  | "pipelineFailed"
  | "invalidTask"
  | "infrastructure";

export type TaskFailure = {
  kind: TaskFailureKind;
  message: string;
  detail?: JsonValue;
  retryable: boolean;
};
