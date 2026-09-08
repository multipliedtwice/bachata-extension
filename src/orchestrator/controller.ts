import { readTimeoutSetting } from "../state/timeoutBounds";
import { setOptionalProperty } from "../state/optionalProperty";
import { shouldCreateManagedCommit, type ManagedCommitMode } from "./managedCommitPolicy";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { ConversationManager } from "../conversations/createConversationManager";
import { repositoryCheckClaim } from "../concurrency/repositoryResources";
import {
  ResourceAcquireTimeoutError,
  ResourceQuarantinedError,
  ResourceBroker,
  ResourceClaim,
  ResourceLease,
  resourceKey,
} from "../concurrency/resourceBroker";
import { configuredProcessEnvironment } from "../process/safeEnvironment";
import {
  parsePipelineSnapshot,
  pipelineSnapshotsEqual,
  PipelineSnapshot,
} from "../pipeline/identity";
import { ExecutionChecklistIssue } from "../pipeline/types";
import type { PipelineReadiness, ReadinessFinding, ReadinessStatus } from "../readiness/model";
import { formatRunTitle } from "../state/identifiers";
import { WorkspaceMutationRunner } from "../state/workspaceMutationFence";
import { assertWorkspacePathAllowed } from "../browser/mutationPolicy";
import { canonicalizePath } from "../pipeline/catalogStorage";
import { buildMasterPrompt, buildTaskPrompt, dependencySummary } from "./context";
import { runVerificationChecks } from "./commandRunner";
import { selectRunnableTasks, terminalLedgerStatus } from "./scheduler";
import { createOrchestrationStore } from "./store";
import { retainedOrchestrationSummary } from "./summarize";
import { markTodoTaskCompleted, normalizeCheckResourceNames, parseTodoDocument, repositoryPathComparisonKey } from "./todoParser";
import {
  GeneratedTodoPlan,
  JsonValue,
  MasterCheck,
  MasterDeviation,
  MasterDeviationKind,
  OrchestrationLedger,
  OrchestrationSnapshot,
  OrchestrationTaskState,
  SelfImprovementReviewRecord,
  TaskExecutionResult,
  VerificationCheckResult,
} from "./types";
import {
  createWorktreeManager,
  RunWorktree,
  TaskWorktree,
} from "./worktreeManager";
import type { ApplyRunResult } from "./worktreeManager";
import type { PatchFileSummary, PatchSelection } from "./patchSelection";
import { isRepositoryVerifierCommand } from "./verificationPolicy";
import type { RepositoryVerifierAuthority } from "./verificationPolicy";
import {
  auditGateErrors,
  buildConvergencePrompt,
  buildDiscoveryPrompt,
  buildLeadReviewPrompt,
  buildRevisionPacket,
  buildWorkerPacket,
  parseRepositoryAudit,
  parseSelfImprovementPlan,
  parseSelfImprovementReview,
  planRepositoryErrors,
  renderExecutableTodo,
  selfImprovementIssues,
} from "./selfImprovement";
import type {
  CandidateIdentity,
  RepositoryAudit,
  SelfImprovementPlan,
  SelfImprovementReview,
} from "./selfImprovement";
import { findVerifier, VERIFIER_REGISTRY_PATH } from "./verifierRegistry";
import { loadVerifierRegistry } from "./verifierRegistryStore";
import {
  retainedApplyRefusal,
  retainedCandidateFingerprint,
  withRetainedEvidence,
} from "./retainedVerification";

export type TodoOrchestratorConfiguration = {
  get: <T>(key: string, defaultValue: T) => T;
};

/**
 * What one repository's persisted verifier approval says. `registryDigest` is the descriptor set
 * the person actually approved, as `verifierRegistryDigest` renders it, carried from the stored
 * approval rather than recomputed from the registry on disk — recomputing it would compare the
 * file being checked against itself. A boolean answer, or one naming no digest, is an approval
 * that records no descriptor set, so the run can only enforce that some approval exists.
 */
export type RepositoryVerifierApproval = {
  approved: boolean;
  registryDigest?: string;
};

export type TodoOrchestratorDependencies = {
  storageRoot: string;
  workspaceRoot: () => string;
  isWorkspaceTrusted: () => boolean;
  configuration: () => TodoOrchestratorConfiguration;
  output: { appendLine: (message: string) => void };
  manager: ConversationManager;
  resourceBroker?: ResourceBroker;
  workspaceLease?: ResourceLease;
  withWorkspaceMutation?: WorkspaceMutationRunner;
  // Absent, false, or `approved: false` means every repository-declared descriptor stays
  // refused. The extension supplies this from one persisted workspace-level approval; it is
  // never read from a ledger.
  /** EX-G6-08. Approval is asked and stored per repository, so the answer needs one named. */
  approvedRepositoryVerifiers?: (repositoryRoot: string) => boolean | RepositoryVerifierApproval;
  /**
   * EX-G6-05 / EX-A5-R12. The two orchestration operations whose rejection reaches `runLoop`
   * with sibling tasks still running: persisting a ledger, and removing a task's worktree at the
   * top of a retry attempt. Neither sits inside `executeTask`'s provider `try`, so either one
   * rejects the whole task promise and `Promise.race(active.values())` rejects with `active`
   * still populated. Nothing in production supplies this; a test throws from it to reach that
   * branch at a chosen moment, which filesystem sabotage cannot do without also failing
   * `runLoop`'s own trailing save. `retainedEvidence` is the third: the window between a
   * retained run's last check finishing and its evidence being written, which holds no other
   * await and which the second HEAD reading exists to close.
   */
  beforeOrchestrationOperation?: (
    operation: "save" | "removeTask" | "retainedEvidence",
    detail: { runId: string; taskId?: string },
  ) => void | Promise<void>;
};

export type GeneratedChecklistRun = {
  workspaceRoot: string;
  parentRunRef: string;
  parentConversationId: string;
  title: string;
  pipelineId: string;
  pipelineSnapshot: PipelineSnapshot;
  issues: ExecutionChecklistIssue[];
  selectedIssueIds: string[];
  userNote: string;
  allowedPaths: string[];
  checks: string[];
  checkResources?: string[];
  allowedDirtyPaths?: string[];
  sealedInputPaths?: string[];
  allowNoChecks: boolean;
  retries: number;
  maxConcurrency: number;
};

export type OrchestrationContract = {
  workspaceRoot: string;
  todoFile: string;
  taskIds: string[];
  taskPipelineIds: string[];
  masterPipelineId: string;
  verification: string[];
  finalVerification: string[];
  verificationResources: string[];
  writablePaths: string[];
  maxConcurrency: number;
  retries: number;
  commitPolicy: "never";
  isolation: string;
  humanDecisions: string[];
  completion: string[];
};

export type TodoStartReadiness = PipelineReadiness & {
  contract?: OrchestrationContract;
  /**
   * EX-G6-08. The repository this readiness was computed against, so the caller shows, approves
   * and persists against the same one the run would execute in. A window can hold more than one
   * repository, and "the workspace" is not an answer.
   */
  workspaceRoot?: string;
};

export type ImproveReadiness = TodoStartReadiness & {
  todoExecutable: boolean;
  todoDiagnostic?: string;
  repositoryVerifiers: RepositoryVerifierAuthority;
  bootstrapPipelineIds: string[];
  // Task pipelines this run would use that are not the review-free self-improvement pipeline.
  // Their own steps may include a review, which necessarily runs before the controller's checks.
  taskPipelinesWithOwnSteps: string[];
};

export type ImproveOutcome = {
  ledger: OrchestrationLedger;
  path: "existingTodo" | "generatedPlan";
};

export type TodoOrchestrator = {
  start: (options?: { sealedInputPaths?: string[]; workspaceRoot?: string }) => Promise<OrchestrationLedger>;
  improve: (options?: { sealedInputPaths?: string[]; workspaceRoot?: string }) => Promise<ImproveOutcome>;
  inspectImproveReadiness: (options?: { sealedInputPaths?: string[] }) => Promise<ImproveReadiness>;
  dirtyRepositoryPaths: () => Promise<string[]>;
  inspectStartReadiness: (
    options?: { sealedInputPaths?: string[]; workspaceRoot?: string },
  ) => Promise<TodoStartReadiness>;
  startChecklist: (request: GeneratedChecklistRun) => Promise<OrchestrationLedger>;
  preflightChecklist: (request: {
    workspaceRoot: string;
    allowedDirtyPaths?: string[];
  }) => Promise<void>;
  resume: () => Promise<OrchestrationLedger>;
  resumeIfAvailable: () => Promise<OrchestrationLedger | undefined>;
  stop: () => Promise<void>;
  abandon: () => Promise<void>;
  cleanupRetained: (runId: string) => Promise<void>;
  resolveRetainedWorktree: (runId: string) => Promise<string>;
  retainedRunPatch: (runId: string, selection?: PatchSelection) => Promise<string>;
  retainedRunPatchFiles: (runId: string) => Promise<PatchFileSummary[]>;
  rerunRetainedChecks: (runId: string) => Promise<VerificationCheckResult[]>;
  verifyRetainedSelection: (
    runId: string,
    selection: PatchSelection,
  ) => Promise<VerificationCheckResult[]>;
  applyRetained: (runId: string, selection?: PatchSelection) => Promise<ApplyRunResult>;
  getSnapshot: () => OrchestrationSnapshot;
  onDidChange: (listener: (snapshot: OrchestrationSnapshot) => void) => { dispose: () => void };
  dispose: () => Promise<void>;
};

class OrchestrationStoppedError extends Error {
  constructor() {
    super("Orchestration was stopped");
    this.name = "OrchestrationStoppedError";
  }
}

const relativeTodoPath = async (repositoryRoot: string, todoPath: string): Promise<string> => {
  const [canonicalRoot, canonicalTodo] = await Promise.all([
    canonicalizePath(repositoryRoot),
    canonicalizePath(todoPath),
  ]);
  const relative = path.relative(canonicalRoot, canonicalTodo);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("TODO.md must be inside the Git repository");
  }
  return relative.replaceAll("\\", "/");
};

const scoped = (file: string, scope: string): boolean => {
  const normalizedFile = repositoryPathComparisonKey(file);
  const normalizedScope = repositoryPathComparisonKey(scope);
  if (!normalizedScope) {
    return true;
  }
  return normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`);
};

const outOfScopeFiles = (task: OrchestrationTaskState, files: string[]): string[] =>
  task.spec.paths.length === 0
    ? [...files]
    : files.filter((file) => !task.spec.paths.some((scope) => scoped(file, scope)));

const checkFailureText = (checks: VerificationCheckResult[]): string =>
  checks
    .filter((check) => check.status !== "passed")
    .map((check) => [
      `$ ${check.command}`,
      `Status: ${check.status}${check.exitCode === undefined ? "" : ` (${String(check.exitCode)})`}`,
      check.stdout ? `stdout:\n${check.stdout}` : "",
      check.stderr ? `stderr:\n${check.stderr}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");

const taskWorktree = (task: OrchestrationTaskState, commitMode: ManagedCommitMode = "never"): TaskWorktree | undefined =>
  task.worktreePath && task.branch && task.baseCommit
    ? {
        taskId: task.spec.id,
        worktreePath: task.worktreePath,
        branch: task.branch,
        baseCommit: task.baseCommit,
        commitMode,
        ...(task.baseTree ? { baseTree: task.baseTree } : {}),
      }
    : undefined;

const ledgerCommitMode = (_ledger: OrchestrationLedger): ManagedCommitMode => "never";

/*
 * A recorded ordering, or nothing. A ledger written before the count existed records none, and a
 * value that is not a whole count answers nothing either: both read as "unknown", which resume
 * refuses on rather than reads as zero.
 */
const recordedCount = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const acceptedIntegrations = (ledger: OrchestrationLedger): number =>
  recordedCount(ledger.acceptedIntegrations) ?? 0;

const runWorktree = (ledger: OrchestrationLedger): RunWorktree => ({
  repositoryRoot: ledger.workspaceRoot,
  baselineCommit: ledger.baselineCommit,
  integrationBranch: ledger.integrationBranch,
  integrationWorktree: ledger.integrationWorktree,
  ...(ledger.inputTree ? { inputTree: ledger.inputTree } : {}),
  ...(ledger.sealedInputPaths ? { sealedInputPaths: [...ledger.sealedInputPaths] } : {}),
  ...(ledger.integrationTree ? { integrationTree: ledger.integrationTree } : {}),
  commitMode: ledgerCommitMode(ledger),
});

const summaryFor = (
  task: OrchestrationTaskState,
  changedFiles: string[],
): string =>
  changedFiles.length === 0
    ? `${task.spec.id} completed with no repository changes.`
    : `${task.spec.id} completed and changed ${String(changedFiles.length)} file${changedFiles.length === 1 ? "" : "s"}.`;

const masterDeviationKinds = new Set<MasterDeviationKind>([
  "skippedTask",
  "wrongTask",
  "missingCompletion",
  "stalledTask",
  "retryPolicy",
  "todoState",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseMasterDecision = (
  value: unknown,
  tasks: Record<string, OrchestrationTaskState>,
): Pick<MasterCheck, "status" | "deviations"> => {
  if (!isRecord(value) || (value.status !== "continue" && value.status !== "deviation")) {
    throw new Error("Master output must contain status=continue or status=deviation");
  }
  if (!Array.isArray(value.deviations)) {
    throw new Error("Master output must contain a deviations array");
  }
  const deviations = value.deviations.map((item, index): MasterDeviation => {
    if (
      !isRecord(item) ||
      typeof item.taskId !== "string" ||
      typeof item.kind !== "string" ||
      !masterDeviationKinds.has(item.kind as MasterDeviationKind) ||
      typeof item.details !== "string"
    ) {
      throw new Error(`Master deviation ${String(index + 1)} is invalid`);
    }
    if (!tasks[item.taskId]) {
      throw new Error(`Master referenced unknown task ${item.taskId}`);
    }
    const details = item.details.trim();
    if (!details) {
      throw new Error(`Master deviation ${String(index + 1)} has no details`);
    }
    return {
      taskId: item.taskId,
      kind: item.kind as MasterDeviationKind,
      details,
    };
  });
  if (value.status === "continue" && deviations.length > 0) {
    throw new Error("Master status=continue requires an empty deviations array");
  }
  if (value.status === "deviation" && deviations.length === 0) {
    throw new Error("Master status=deviation requires at least one deviation");
  }
  return { status: value.status, deviations };
};

const masterStateFingerprint = (ledger: OrchestrationLedger): string =>
  JSON.stringify(Object.values(ledger.tasks).map((task) => [
    task.spec.id,
    task.status,
    task.attempts,
    task.result?.status ?? null,
    task.result?.pipelineStatus ?? null,
    task.completedAt ?? null,
    task.lastError ?? null,
  ]));

const resetIncompleteTask = (task: OrchestrationTaskState, reason: string): void => {
  if (task.status === "done") {
    return;
  }
  const interruptedAttempt =
    ["running", "waitingForResources", "verifying", "integrating"].includes(task.status) ||
    (task.status === "cancelled" && task.result?.status !== "failed");
  if (interruptedAttempt && !task.implementationComplete && task.attempts > 0) {
    task.attempts -= 1;
  }
  task.lastError = reason;
  if (
    (task.status === "failed" || task.result?.status === "failed") &&
    task.attempts > task.spec.retries
  ) {
    task.status = "failed";
    task.completedAt ??= new Date().toISOString();
    task.lastError = `${reason}. Retry budget exhausted after ${String(task.attempts)} attempt${task.attempts === 1 ? "" : "s"}.`;
    return;
  }
  task.status = "pending";
  delete task.completedAt;
};

const normalizeGeneratedPath = (value: string): string => {
  const platformPath = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  const normalized = path.posix.normalize(platformPath).replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!normalized || normalized === ".") {
    return ".";
  }
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    throw new Error(`Invalid generated task path: ${value}`);
  }
  return normalized;
};

const generatedTaskIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;

// A checklist run is bounded by the scope its user authored, and every generated task has to
// fall inside it. A self-improvement plan has no such bound: its own tasks are the only source of
// the scope, so containment against them would answer itself. That case says so rather than
// passing the plan its own paths and reading the result as a check.
const validateGeneratedTasks = (
  issues: ExecutionChecklistIssue[],
  scope: { authority: "user"; allowedPaths: string[] } | { authority: "plan" },
): { issuePaths: Map<string, string[]>; allowedPaths: string[] } => {
  if (issues.length === 0) {
    throw new Error("The selected checklist contains no tasks");
  }
  const authoredPaths = scope.authority === "user"
    ? Array.from(new Set(scope.allowedPaths.map(normalizeGeneratedPath)))
    : undefined;
  if (authoredPaths?.length === 0) {
    throw new Error("Checklist execution requires at least one user-authored allowed path");
  }
  const ids = new Set<string>();
  const normalizedIssuePaths = new Map<string, string[]>();
  issues.forEach((issue) => {
    if (!generatedTaskIdPattern.test(issue.id)) {
      throw new Error(`Generated task id is invalid: ${issue.id}`);
    }
    if (ids.has(issue.id)) {
      throw new Error(`Duplicate generated task id: ${issue.id}`);
    }
    const paths = Array.from(new Set(issue.paths.map(normalizeGeneratedPath)));
    if (paths.length === 0) {
      throw new Error(`Generated task ${issue.id} has no path scope`);
    }
    const outside = authoredPaths === undefined
      ? []
      : paths.filter(
        (generatedPath) => !authoredPaths.some((allowedPath) => scoped(generatedPath, allowedPath)),
      );
    if (outside.length > 0) {
      throw new Error(
        `Generated task ${issue.id} exceeds the user-authored scope: ${outside.join(", ")}`,
      );
    }
    ids.add(issue.id);
    normalizedIssuePaths.set(issue.id, paths);
  });
  issues.forEach((issue) => {
    issue.dependencies.forEach((dependency) => {
      if (!ids.has(dependency)) {
        throw new Error(`Generated task ${issue.id} depends on unselected task ${dependency}`);
      }
      if (dependency === issue.id) {
        throw new Error(`Generated task ${issue.id} depends on itself`);
      }
    });
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`Generated task dependency cycle contains ${id}`);
    }
    visiting.add(id);
    byId.get(id)?.dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  issues.forEach((issue) => visit(issue.id));
  return {
    issuePaths: normalizedIssuePaths,
    allowedPaths: authoredPaths ?? Array.from(new Set(Array.from(normalizedIssuePaths.values()).flat())),
  };
};

export const createTodoOrchestrator = (
  dependencies: TodoOrchestratorDependencies,
): TodoOrchestrator => {
  const { storageRoot, output, manager } = dependencies;
  const configuration = dependencies.configuration;
  const store = createOrchestrationStore(storageRoot, {
    ...(dependencies.withWorkspaceMutation === undefined
      ? {}
      : { withMutation: dependencies.withWorkspaceMutation }),
  });
  let controller: AbortController | undefined;
  const worktrees = createWorktreeManager(storageRoot, {
    ...(dependencies.resourceBroker === undefined
      ? {}
      : { resourceBroker: dependencies.resourceBroker }),
    lockTimeoutMs: () => readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "gitAdministrationTimeoutMs", 120_000),
    signal: () => controller?.signal,
  });
  const listeners = new Set<(snapshot: OrchestrationSnapshot) => void>();
  const activeConversations = new Set<string>();
  const activeCheckLeases = new Set<ResourceLease>();
  const retainedLedgers = new Map<string, OrchestrationLedger>();
  const workspaceRoot = dependencies.workspaceRoot;
  let ledger: OrchestrationLedger | undefined;
  let operation: Promise<OrchestrationLedger> | undefined;
  let orchestrationOwnerLease: ResourceLease | undefined;
  let orchestrationOwnerUnsafeReason: string | undefined;
  let integrationQueue: Promise<void> = Promise.resolve();
  let startupClaimed = false;
  let disposed = false;
  let maintenanceController: AbortController | undefined;
  let startupController: AbortController | undefined;
  const pendingWork = new Set<Promise<void>>();

  const assertWorkspaceLease = (): void => dependencies.workspaceLease?.assertValid();
  const workspaceLeaseValid = (): boolean => !dependencies.workspaceLease || dependencies.workspaceLease.isValid();

  const snapshot = (): OrchestrationSnapshot => ({
    active: Boolean(operation) || startupClaimed,
    ...(ledger ? { run: structuredClone(ledger) } : {}),
    retainedRuns: Array.from(retainedLedgers.values(), retainedOrchestrationSummary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  });

  const emit = (): void => {
    const value = snapshot();
    listeners.forEach((listener) => listener(value));
  };

  const save = async (current: OrchestrationLedger): Promise<void> => {
    assertWorkspaceLease();
    await dependencies.beforeOrchestrationOperation?.("save", { runId: current.runId });
    await store.save(current);
    if (ledger?.runId === current.runId) {
      ledger = current;
    }
    if (current.status === "completed" || current.status === "cleanupPending") {
      retainedLedgers.set(current.runId, structuredClone(current));
    } else {
      retainedLedgers.delete(current.runId);
    }
    emit();
  };

  const trackWork = async <T>(work: () => Promise<T>): Promise<T> => {
    let settle: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    pendingWork.add(gate);
    try {
      return await work();
    } finally {
      pendingWork.delete(gate);
      settle();
    }
  };

  const drainPendingWork = async (): Promise<boolean> => {
    if (pendingWork.size === 0) {
      return true;
    }
    const timeoutMs = Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "todoStopTimeoutMs", 30_000));
    try {
      await bounded(
        Promise.allSettled(Array.from(pendingWork)).then(() => undefined),
        timeoutMs,
        "TODO background work stop",
      );
      return true;
    } catch (error) {
      output.appendLine(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const claimStartup = (): void => {
    assertWorkspaceLease();
    if (operation || startupClaimed) {
      throw new Error("TODO orchestration is already active");
    }
    startupClaimed = true;
    startupController = new AbortController();
    emit();
  };

  const assertStartupNotCancelled = (): void => {
    if (startupController?.signal.aborted || disposed) {
      throw new OrchestrationStoppedError();
    }
  };

  const releaseStartup = (): void => {
    if (!startupClaimed) {
      return;
    }
    startupClaimed = false;
    startupController = undefined;
    emit();
  };

  const bounded = async <T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), Math.max(1, timeoutMs));
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const acquireOrchestrationOwner = async (
    root: string,
    label: string,
  ): Promise<void> => {
    assertWorkspaceLease();
    if (!dependencies.resourceBroker) {
      return;
    }
    if (orchestrationOwnerLease) {
      throw new Error("TODO orchestration ownership is already held");
    }
    const repositoryIdentity = await worktrees.repositoryIdentity(root);
    orchestrationOwnerLease = await dependencies.resourceBroker.acquire({
      resources: [{
        key: resourceKey("todo-orchestration-owner", repositoryIdentity),
        kind: "physical",
      }],
      deadlineAt: Date.now() + Math.max(
        500,
        readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "todoOwnerTimeoutMs", 2_000),
      ),
      label,
    });
    orchestrationOwnerLease.signal?.addEventListener("abort", () => controller?.abort(), { once: true });
  };

  const quarantineOrchestrationOwner = async (reason: string): Promise<void> => {
    const lease = orchestrationOwnerLease;
    if (!lease) {
      orchestrationOwnerUnsafeReason = undefined;
      return;
    }
    orchestrationOwnerUnsafeReason = reason;
    await lease.quarantine(reason);
    if (orchestrationOwnerLease === lease) {
      orchestrationOwnerLease = undefined;
    }
    orchestrationOwnerUnsafeReason = undefined;
  };

  const releaseOrchestrationOwner = async (): Promise<void> => {
    const lease = orchestrationOwnerLease;
    if (!lease) {
      orchestrationOwnerUnsafeReason = undefined;
      return;
    }
    if (orchestrationOwnerUnsafeReason) {
      await quarantineOrchestrationOwner(orchestrationOwnerUnsafeReason);
      return;
    }
    try {
      await lease.release();
    } catch (releaseError) {
      const reason = `TODO lifecycle owner release was not confirmed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
      orchestrationOwnerUnsafeReason = reason;
      try {
        await lease.quarantine(reason);
      } catch (quarantineError) {
        throw new AggregateError(
          [releaseError, quarantineError],
          "TODO lifecycle ownership could neither be released nor quarantined",
        );
      }
      output.appendLine(`${reason}. The repository was quarantined.`);
    }
    if (orchestrationOwnerLease === lease) {
      orchestrationOwnerLease = undefined;
    }
    orchestrationOwnerUnsafeReason = undefined;
  };

  const failUnsafeStartupRollback = async (
    error: unknown,
    cleanupError: unknown,
    label: string,
  ): Promise<never> => {
    const reason = `${label}: startup rollback cleanup was not confirmed`;
    const errors = [error, cleanupError];
    try {
      await quarantineOrchestrationOwner(reason);
    } catch (quarantineError) {
      errors.push(quarantineError);
    }
    throw new AggregateError(errors, label);
  };

  const declaredCheckClaims = async (
    current: OrchestrationLedger,
    resources: string[],
  ): Promise<ResourceClaim[]> => {
    const repositoryIdentity = await worktrees.repositoryIdentity(current.workspaceRoot);
    const claims: ResourceClaim[] = [
      {
        key: resourceKey("checks-global", "machine"),
        capacity: Math.max(1, configuration().get<number>("todoGlobalCheckConcurrency", 1)),
        kind: "abstract",
      },
      repositoryCheckClaim({
        canonicalWorkingDirectory: current.integrationWorktree,
        repositoryIdentity,
        repositoryRoot: current.workspaceRoot,
      }),
    ];
    for (const declared of normalizeCheckResourceNames(resources)) {
      const global = declared.startsWith("global:");
      const identity = global ? declared.slice("global:".length) : `${repositoryIdentity}\0${declared}`;
      claims.push({
        key: resourceKey(global ? "check-resource-global" : "check-resource-repository", identity),
        kind: "physical",
      });
    }
    return claims;
  };

  const currentWorkspaceOwns = (current: OrchestrationLedger): boolean => {
    let ownerRoot: string;
    try {
      ownerRoot = path.resolve(workspaceRoot());
    } catch {
      return false;
    }
    if (current.ownerWorkspaceRoot) {
      return path.resolve(current.ownerWorkspaceRoot) === ownerRoot;
    }
    const relativeOwner = path.relative(path.resolve(current.workspaceRoot), ownerRoot);
    return !relativeOwner.startsWith("..") && !path.isAbsolute(relativeOwner);
  };

  const assertCurrentWorkspaceOwns = (current: OrchestrationLedger): void => {
    if (!currentWorkspaceOwns(current)) {
      throw new Error("The retained TODO run belongs to a different workspace");
    }
  };

  const abandonedLedger = (current: OrchestrationLedger): OrchestrationLedger => {
    const finalized = structuredClone(current);
    Object.values(finalized.tasks).forEach((task) => {
      delete task.worktreePath;
      delete task.branch;
      delete task.baseCommit;
      delete task.baseTree;
      delete task.commit;
      delete task.integrationRollbackCommit;
      delete task.integrationRollbackSequence;
      if (task.status !== "done") {
        task.status = "cancelled";
        task.completedAt ??= new Date().toISOString();
      }
    });
    finalized.status = "abandoned";
    finalized.error = "Abandoned by the user";
    return finalized;
  };

  const reconcilePendingCleanup = async (current: OrchestrationLedger): Promise<OrchestrationLedger | undefined> => {
    if (!currentWorkspaceOwns(current)) {
      return current;
    }
    if (current.status !== "abandoning" && current.status !== "cleanupPending") {
      return current;
    }
    await acquireOrchestrationOwner(current.workspaceRoot, `reconcile TODO cleanup ${current.runId}`);
    try {
      await worktrees.abandonRun(runWorktree(current));
      const activeRunId = await store.getActiveRun();
      if (current.status === "cleanupPending") {
        if (activeRunId === current.runId) {
          await store.setActiveRun(undefined);
        }
        await store.remove(current.runId);
        return undefined;
      }
      const finalized = abandonedLedger(current);
      await store.save(finalized);
      if (activeRunId === current.runId) {
        try {
          await store.setActiveRun(undefined);
        } catch (error) {
          output.appendLine(`TODO run ${current.runId} was abandoned, but its active pointer could not be cleared: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return finalized;
    } finally {
      await releaseOrchestrationOwner();
    }
  };

  const refreshRetainedRuns = async (): Promise<void> => {
    const runIds = await store.listRunIds();
    const loaded = await Promise.all(runIds.map(async (runId) => {
      try {
        return await store.load(runId);
      } catch (error) {
        output.appendLine(`Ignored invalid orchestration ledger ${runId}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }));
    const reconciled: OrchestrationLedger[] = [];
    for (const current of loaded) {
      if (!current) {
        continue;
      }
      try {
        const value = await reconcilePendingCleanup(current);
        if (value) {
          reconciled.push(value);
        }
      } catch (error) {
        output.appendLine(`Could not reconcile TODO cleanup ${current.runId}: ${error instanceof Error ? error.message : String(error)}`);
        reconciled.push(current);
      }
    }
    retainedLedgers.clear();
    reconciled.forEach((current) => {
      if (
        (current.status === "completed" || current.status === "cleanupPending") &&
        currentWorkspaceOwns(current)
      ) {
        retainedLedgers.set(current.runId, current);
      }
    });
    const activeRunId = await store.getActiveRun();
    const activeLedger = activeRunId
      ? reconciled.find((current) => current.runId === activeRunId)
      : undefined;
    if (activeLedger && (activeLedger.status === "completed" || activeLedger.status === "abandoned")) {
      try {
        await store.setActiveRun(undefined);
      } catch (error) {
        output.appendLine(`Could not clear stale active TODO pointer ${activeLedger.runId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (
      activeLedger?.status === "abandoning" &&
      currentWorkspaceOwns(activeLedger)
    ) {
      ledger = structuredClone(activeLedger);
    }
    emit();
  };

  const initialization = refreshRetainedRuns().catch((error) => {
    output.appendLine(`Could not load retained TODO runs: ${error instanceof Error ? error.message : String(error)}`);
  });

  const createMasterConversation = async (input: {
    title: string;
    parentConversationId?: string;
    pipelineSnapshot?: PipelineSnapshot;
  }): Promise<{
    conversationId: string;
    runId: string;
    pipelineId: string;
    pipelineSnapshot: PipelineSnapshot;
  }> => {
    const pipelineId = input.pipelineSnapshot?.definition.id ??
      configuration().get<string>("todoMasterPipeline", "todo-master");
    const masterDirectory = path.join(storageRoot, "orchestration", "master");
    await mkdir(masterDirectory, { recursive: true });
    const conversation = await manager.createConversation({
      title: input.title,
      pipelineId,
      ...(input.pipelineSnapshot
        ? { pipelineSnapshot: structuredClone(input.pipelineSnapshot) }
        : {}),
      workingDirectory: masterDirectory,
      pipelineScopeRoot: path.resolve(workspaceRoot()),
      ...(input.parentConversationId
        ? { parentConversationId: input.parentConversationId }
        : {}),
    });
    const pipelineSnapshot = input.pipelineSnapshot ??
      await manager.resolvePipelineSnapshot(
        conversation.id,
        pipelineId,
        {
          requireCurrentCatalog: true,
          unattended: true,
          rejectChecklist: true,
        },
      );
    return {
      conversationId: conversation.id,
      runId: conversation.runRef ?? conversation.id,
      pipelineId,
      pipelineSnapshot,
    };
  };

  /*
   * One persisted workspace approval plus an explicit Improve run is what lets a repository
   * descriptor start at all. It is recomputed from the live workspace on every run and resume,
   * never read back from a ledger, so a stored value can never widen what may execute.
   *
   * The approval also carries the descriptor set it was given for, so the registry the run reads
   * from its own worktree can be held against the one the person saw. An approval that names no
   * descriptor set still authorizes, exactly as before; it simply cannot answer for one.
   */
  const repositoryVerifierApprovalFor = (
    mode: OrchestrationLedger["mode"],
    repositoryRoot: string | undefined,
  ): { authority: RepositoryVerifierAuthority; registryDigest?: string } => {
    if (mode !== "selfImprovement" || repositoryRoot === undefined) return { authority: "refused" };
    const answer = dependencies.approvedRepositoryVerifiers?.(path.resolve(repositoryRoot));
    const approval: RepositoryVerifierApproval = typeof answer === "object"
      ? answer
      : { approved: answer === true };
    if (!approval.approved) return { authority: "refused" };
    return {
      authority: "humanApproved",
      ...(approval.registryDigest === undefined ? {} : { registryDigest: approval.registryDigest }),
    };
  };

  const repositoryVerifierAuthorityFor = (
    mode: OrchestrationLedger["mode"],
    repositoryRoot: string | undefined,
  ): RepositoryVerifierAuthority => repositoryVerifierApprovalFor(mode, repositoryRoot).authority;


  const selfImprovementPipelineIds = (): {
    task: string;
    discovery: string;
    convergence: string;
    review: string;
    revision: string;
  } => ({
    task: configuration().get<string>("improvePipeline", "self-improvement"),
    discovery: configuration().get<string>("improveDiscoveryPipeline", "self-improvement-discovery"),
    convergence: configuration().get<string>("improveConvergencePipeline", "self-improvement-convergence"),
    review: configuration().get<string>("improveReviewPipeline", "self-improvement-review"),
    revision: configuration().get<string>("improveRevisionPipeline", "self-improvement-revision"),
  });

  /*
   * The controller runs the declared checks before its own Lead review. A task pipeline may also
   * carry a review step of its own, which necessarily runs inside the pipeline and therefore
   * before those checks. An Improve run defaults to the review-free self-improvement pipeline so
   * the common path has exactly one review, after the checks; a task that names its own pipeline
   * keeps it, and the contract says so rather than claiming otherwise.
   */
  const defaultTaskPipelineId = (mode: OrchestrationLedger["mode"]): string =>
    mode === "selfImprovement"
      ? configuration().get<string>("improvePipeline", "self-improvement")
      : configuration().get<string>("todoPipeline", "todo-implementation");

  const maxRevisionCycles = (): number =>
    Math.max(0, Math.min(5, configuration().get<number>("improveMaxRevisionCycles", 1)));

  const improveLockedDecisions = (current: OrchestrationLedger): string[] => [
    "Functional style. Reuse and deduplicate existing modules instead of adding parallel ones.",
    "Avoid `as any` and avoid `unknown` casts where a real type is available.",
    "Add a comment only to preserve a non-obvious invariant.",
    "Nothing is committed or pushed. The controller integrates accepted work and a human applies it.",
    `Stay inside the declared path scope; the controller rejects any file outside it.`,
    `Do not run E2E, Cypress, Playwright, browser, Docker, database, or shared-resource commands. The controller runs ${current.mode === "selfImprovement" ? "the declared checks" : "protected checks"} itself.`,
  ];

  /*
   * A fixed, dedicated name. The configured TODO file is the human's, and an Improve run that
   * had to generate a plan is exactly the run whose workspace TODO is missing or not executable
   * — writing there could overwrite prose the human still wants when the result is applied.
   */
  const FALLBACK_GENERATED_TODO_PATH = "BACHATA_IMPROVE.md";

  /*
   * A missing configured TODO is the file the human asked for and does not have, so the plan is
   * written there. A TODO that exists but is not executable is prose the human still wants; that
   * one is preserved and the plan goes to a dedicated file beside it.
   */
  const generatedTodoTarget = async (
    root: string,
    candidateWorktree: string,
  ): Promise<string> => {
    const location = await configuredTodoLocation(root);
    const relative = path.relative(await canonicalizePath(root), location.path);
    const posixRelative = relative.split(path.sep).join("/");
    return existsSync(path.join(candidateWorktree, ...posixRelative.split("/")))
      ? FALLBACK_GENERATED_TODO_PATH
      : posixRelative;
  };

  const writeGeneratedTodo = async (
    current: OrchestrationLedger,
    source: string,
  ): Promise<void> => {
    const relative = current.generatedTodoPath as string;
    const target = path.join(current.integrationWorktree, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
    await worktrees.commitIntegration(
      runWorktree(current),
      `Bachata Improve: record the generated plan in ${relative}`,
    );
    if (!shouldCreateManagedCommit(current.commitMode)) {
      current.integrationTree = await worktrees.integrationCommit(runWorktree(current));
    }
  };

  const candidateIdentity = (
    current: OrchestrationLedger,
    candidateWorktree: string,
  ): CandidateIdentity => ({
    repositoryRoot: current.workspaceRoot,
    baselineCommit: current.baselineCommit,
    ...(current.inputTree ? { inputTree: current.inputTree } : {}),
    candidateWorktree,
  });

  const runMasterCheck = async (
    current: OrchestrationLedger,
    phase: MasterCheck["phase"],
  ): Promise<MasterCheck> => {
    assertRunning(current);
    const conversationId = current.masterConversationId;
    if (!conversationId) {
      throw new Error("TODO run has no Master conversation");
    }
    const masterPipelineSnapshot = current.masterPipelineSnapshot;
    if (!masterPipelineSnapshot) {
      throw new Error(
        "This TODO run predates immutable Master pipeline snapshots. Abandon it and start a new run.",
      );
    }
    await manager.configurePipelineSnapshot(
      conversationId,
      masterPipelineSnapshot,
    );
    activeConversations.add(conversationId);
    let result: Awaited<ReturnType<ConversationManager["runConversation"]>>;
    try {
      result = await manager.runConversation(
        conversationId,
        buildMasterPrompt(current, phase),
        [],
        1,
        { pipelineSnapshot: masterPipelineSnapshot },
      );
    } finally {
      activeConversations.delete(conversationId);
    }
    if (controller?.signal.aborted) {
      throw new OrchestrationStoppedError();
    }
    if (result.pipeline.status !== "completed") {
      throw new Error("Master progress check was interrupted");
    }
    const artifact = Object.values(result.pipeline.outputs ?? {})
      .flatMap((step) => Object.values(step))
      .find((value) => value.name === "masterDecision");
    if (!artifact) {
      throw new Error(
        `Master pipeline ${current.masterPipelineId ?? ""} must publish typed output masterDecision`,
      );
    }
    const decision = parseMasterDecision(artifact.value, current.tasks);
    const check: MasterCheck = {
      checkedAt: new Date().toISOString(),
      phase,
      status: decision.status,
      deviations: decision.deviations,
      conversationId,
    };
    current.masterChecks.push(check);
    await save(current);
    if (check.status === "deviation") {
      output.appendLine(
        `Master reported execution deviation: ${check.deviations.map((item) => `${item.taskId}/${item.kind}: ${item.details}`).join("; ")}`,
      );
    }
    return check;
  };

  const assertRunning = (current: OrchestrationLedger): void => {
    if (
      !controller ||
      controller.signal.aborted ||
      ledger?.runId !== current.runId ||
      current.status === "stopping" ||
      current.status === "stopped"
    ) {
      throw new OrchestrationStoppedError();
    }
  };

  const integrateSerially = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = integrationQueue;
    let release = (): void => undefined;
    integrationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };

  const assertSameRepository = async (ownerRoot: string, targetRoot: string): Promise<void> => {
    const [ownerIdentity, targetIdentity] = await Promise.all([
      worktrees.repositoryIdentity(ownerRoot),
      worktrees.repositoryIdentity(targetRoot),
    ]);
    if (ownerIdentity !== targetIdentity) {
      throw new Error("The orchestration repository does not match the current workspace repository");
    }
  };

  const runIsolatedChecks = async (
    current: OrchestrationLedger,
    sourceWorktree: string,
    label: string,
    commands: string[],
    resources: string[] = [],
    onAcquired?: () => Promise<void>,
    options: {
      exportSource?: boolean;
      selection?: PatchSelection;
      abort?: () => AbortController | undefined;
    } = {},
  ): Promise<{ checks: VerificationCheckResult[]; sourceChanged: boolean }> => {
    const abortOwner = (): AbortController | undefined =>
      options.abort ? options.abort() : controller;
    if (commands.length === 0) {
      await onAcquired?.();
      return { checks: [], sourceChanged: false };
    }
    let lease: ResourceLease | undefined;
    let cleanupConfirmed = true;
    if (dependencies.resourceBroker) {
      const leaseSignal = abortOwner()?.signal;
      lease = await dependencies.resourceBroker.acquire({
        resources: await declaredCheckClaims(current, resources),
        deadlineAt: Date.now() + Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "todoCheckSlotTimeoutMs", 15 * 60_000)),
        ...(leaseSignal === undefined ? {} : { signal: leaseSignal }),
        label: `TODO verification ${current.runId}/${label}`,
      });
      activeCheckLeases.add(lease);
      lease.signal?.addEventListener("abort", () => abortOwner()?.abort(), { once: true });
    }
    let before: Awaited<ReturnType<typeof worktrees.worktreeState>> | undefined;
    let after: Awaited<ReturnType<typeof worktrees.worktreeState>> | undefined;
    let validation: Awaited<ReturnType<typeof worktrees.prepareValidation>> | undefined;
    let validationAttempted = false;
    let checks: VerificationCheckResult[] = [];
    let pendingFailure: { error: unknown } | undefined;
    try {
      await onAcquired?.();
      before = await worktrees.worktreeState(sourceWorktree);
      validationAttempted = true;
      validation = options.exportSource
        ? await worktrees.prepareExportValidation(
            runWorktree(current),
            label,
            options.selection,
          )
        : await worktrees.prepareValidation(
            runWorktree(current),
            sourceWorktree,
            label,
          );
      // `validation` is an outer `let` the catch block also reads, so it cannot narrow inside
      // the closure below. Capturing the prepared value keeps every use in this block typed
      // without a cast or a non-null assertion.
      const prepared = validation;
      // Only the export preparation stages the candidate (`git apply --index`). The overlay
      // preparation copies files without touching the index, so its index tree names the fetched
      // HEAD, not the candidate these checks ran on; a record naming no tree beats one naming a
      // tree the checks never saw.
      const candidateTree = options.exportSource
        ? (await worktrees.worktreeState(prepared.worktreePath)).indexTree
        : undefined;
      const checkSignal = abortOwner()?.signal;
      // The registry these checks read sits in the run's own worktree, which a task may have
      // rewritten. The approval says which descriptor set a person accepted, so it travels with
      // the authority rather than being recomputed from the file being checked.
      const verifierApproval = repositoryVerifierApprovalFor(current.mode, current.ownerWorkspaceRoot);
      const executedChecks = await runVerificationChecks(commands, {
        cwd: prepared.worktreePath,
        timeoutMs: readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "todoCheckTimeoutMs", 30 * 60_000),
        maxOutputBytes: configuration().get<number>("todoCheckMaxOutputBytes", 2_097_152),
        ...(checkSignal === undefined ? {} : { signal: checkSignal }),
        environment: configuredProcessEnvironment(
          prepared.worktreePath,
          configuration().get<string[]>("todoCheckEnvironmentVariables", []),
        ),
        autonomous: true,
        repositoryVerifiers: verifierApproval.authority,
        ...(verifierApproval.registryDigest === undefined
          ? {}
          : { approvedVerifierRegistryDigest: verifierApproval.registryDigest }),
      });
      checks = executedChecks.map((check, index) => ({
        ...check,
        workingDirectory: prepared.worktreePath,
        ...(candidateTree === undefined ? {} : { candidateTree }),
        outputReference: `verification:${current.runId}:${label}:${String(index + 1)}`,
      }));
      cleanupConfirmed = checks.every((check) => check.cleanupConfirmed !== false);
      after = await worktrees.worktreeState(sourceWorktree);
    } catch (error) {
      if (validationAttempted && !validation) {
        cleanupConfirmed = false;
      }
      pendingFailure = { error };
      throw error;
    } finally {
      if (validation) {
        try {
          await worktrees.removeValidation(runWorktree(current), validation);
        } catch (error) {
          cleanupConfirmed = false;
          output.appendLine(`Validation cleanup failed for ${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (lease) {
        const held = lease;
        activeCheckLeases.delete(held);
        if (cleanupConfirmed) {
          try {
            await held.release();
          } catch (releaseError) {
            // A release nobody confirmed leaves the physical keys held for the rest of the
            // session, so it quarantines like every other release site, and the failure that
            // brought us here is carried alongside rather than replaced by the cleanup's own.
            try {
              await held.quarantine(`Verification lease release was not confirmed for ${current.runId}/${label}`);
            } catch (quarantineError) {
              output.appendLine(`Verification lease quarantine failed for ${label}: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`);
            }
            throw pendingFailure
              ? new AggregateError(
                  [pendingFailure.error, releaseError],
                  `Verification failed for ${current.runId}/${label} and its resource lease could not be released`,
                )
              : releaseError;
          }
        } else {
          await held.quarantine(`Verification cleanup was not confirmed for ${current.runId}/${label}`);
        }
      }
    }
    return {
      checks,
      sourceChanged: JSON.stringify(before) !== JSON.stringify(after),
    };
  };

  const releaseRoom = (task: OrchestrationTaskState): void => {
    if (task.conversationId) {
      activeConversations.delete(task.conversationId);
    }
  };

  // The file the controller owns for this run: the human's TODO, or the checklist an Improve run
  // generated. Either way a worker may not touch it and every accepted task is checked off in it.
  const controllerTodoPath = (current: OrchestrationLedger): string | undefined =>
    current.sourceKind === "todoFile" ? undefined : current.generatedTodoPath;

  const markCompleted = async (
    current: OrchestrationLedger,
    task: OrchestrationTaskState,
  ): Promise<void> => {
    const generated = controllerTodoPath(current);
    if (current.sourceKind === "generatedChecklist" && generated === undefined) {
      return;
    }
    assertRunning(current);
    const relative = generated
      ?? await relativeTodoPath(current.workspaceRoot, current.todoPath as string);
    const integrationTodo = path.join(current.integrationWorktree, ...relative.split("/"));
    const source = await readFile(integrationTodo, "utf8");
    const updated = markTodoTaskCompleted(source, task.spec);
    if (updated === source) {
      throw new Error(`Could not mark TODO task ${task.spec.id} complete`);
    }
    assertRunning(current);
    await writeFile(integrationTodo, updated, "utf8");
    assertRunning(current);
    await worktrees.commitIntegration(runWorktree(current), `Bachata TODO: complete ${task.spec.id}`);
    if (!shouldCreateManagedCommit(current.commitMode)) {
      current.integrationTree = await worktrees.integrationCommit(runWorktree(current));
    }
  };

  const validateTaskDelta = async (
    current: OrchestrationLedger,
    task: OrchestrationTaskState,
    prepared: TaskWorktree,
  ): Promise<string[]> => {
    const changedFiles = await worktrees.changedFiles(prepared);
    const controllerFile = current.sourceKind === "todoFile"
      ? await relativeTodoPath(current.workspaceRoot, current.todoPath as string)
      : controllerTodoPath(current);
    if (controllerFile !== undefined && changedFiles.includes(controllerFile)) {
      throw new Error(`The task changed controller-owned file ${controllerFile}`);
    }
    const outside = outOfScopeFiles(task, changedFiles);
    if (outside.length > 0) {
      throw new Error(outside.map((file) => `Out-of-scope file: ${file}`).join("\n"));
    }
    const wholeWorkspace = task.spec.paths.some((scope) => repositoryPathComparisonKey(scope) === "");
    for (const file of changedFiles) {
      await assertWorkspacePathAllowed(prepared.worktreePath, file, {
        allowedPaths: wholeWorkspace ? ["."] : task.spec.paths,
        scopeMode: wholeWorkspace ? "workspace" : "bounded",
        commitMode: "never",
        readOnly: false,
      });
    }
    return changedFiles;
  };

  const finalAnswerText = (answers: Record<string, Record<string, string>>): string => {
    const steps = Object.keys(answers);
    const last = steps[steps.length - 1];
    return last === undefined ? "" : Object.values(answers[last] ?? {}).join("\n\n");
  };

  const structuredStepOutput = (
    outputs: Record<string, Record<string, { value: unknown; validationErrors: string[] }>>,
    stepId: string,
  ): { value?: JsonValue; errors: string[] } => {
    const step = outputs[stepId];
    const artifact = step === undefined ? undefined : Object.values(step)[0];
    if (!artifact) return { errors: [`The lead produced no ${stepId} output`] };
    if (artifact.validationErrors.length > 0) return { errors: artifact.validationErrors };
    return { value: artifact.value as JsonValue, errors: [] };
  };

  const runLeadReview = async (
    current: OrchestrationLedger,
    task: OrchestrationTaskState,
    prepared: TaskWorktree,
    input: {
      changedFiles: string[];
      checks: VerificationCheckResult[];
      workerReport: string;
      final: boolean;
    },
  ): Promise<{ review?: SelfImprovementReview; error?: string }> => {
    const snapshot = current.reviewPipelineSnapshot;
    if (!snapshot || !current.reviewPipelineId) {
      return { error: "This run carries no immutable lead-review pipeline snapshot" };
    }
    // `taskPatch` stages intent-to-add entries for the length of its diff and `worktreeState`
    // runs `write-tree` on the same index, so these two must never overlap.
    const state = await worktrees.worktreeState(prepared.worktreePath);
    const patch = await worktrees.taskPatch(prepared);
    assertRunning(current);
    const room = await manager.createConversation({
      title: `[${task.spec.id}] ${input.final ? "Final lead review" : "Lead review"}`,
      pipelineId: current.reviewPipelineId,
      pipelineSnapshot: structuredClone(snapshot),
      workingDirectory: prepared.worktreePath,
      pipelineScopeRoot: current.workspaceRoot,
      orchestrationRunId: current.runId,
      orchestrationTaskId: task.spec.id,
      orchestrationBranch: prepared.branch,
      orchestrationBaseCommit: prepared.baseCommit,
      orchestrationPaths: task.spec.paths,
      ...(current.masterConversationId ? { parentConversationId: current.masterConversationId } : {}),
    });
    activeConversations.add(room.id);
    try {
      const execution = await manager.runConversation(
        room.id,
        buildLeadReviewPrompt({
          taskId: task.spec.id,
          outcome: task.spec.title,
          details: task.spec.description || task.spec.title,
          paths: task.spec.paths,
          candidate: candidateIdentity(current, prepared.worktreePath),
          taskTree: state.indexTree,
          changedFiles: input.changedFiles,
          patch,
          checks: input.checks.map((check) => ({
            command: check.command,
            status: check.status,
            ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
            stdout: check.stdout,
            stderr: check.stderr,
          })),
          workerReport: input.workerReport,
          final: input.final,
        }),
        [],
        1,
        // The lead reviews the candidate tree and must not change it; the read-only scope makes
        // the post-turn audit refuse a review that edited anything.
        { pipelineSnapshot: structuredClone(snapshot), commitMode: "never", writeScope: "readOnly" },
      );
      if (execution.pipeline.status !== "completed") {
        return { error: "The lead review pipeline was interrupted" };
      }
      const output = structuredStepOutput(execution.pipeline.outputs, "lead-review");
      if (output.errors.length > 0) return { error: output.errors.join("; ") };
      const parsed = parseSelfImprovementReview(output.value);
      if (!parsed.review) return { error: parsed.errors.join("; ") };
      const record: SelfImprovementReviewRecord = {
        phase: input.final ? "finalReview" : "review",
        verdict: parsed.review.verdict,
        summary: parsed.review.summary,
        defects: parsed.review.defects,
        conversationId: room.id,
        taskTree: state.indexTree,
        reviewedAt: new Date().toISOString(),
      };
      task.reviews = [...(task.reviews ?? []), record];
      await save(current);
      return { review: parsed.review };
    } finally {
      activeConversations.delete(room.id);
      await manager.closeConversation(room.id).catch(() => undefined);
    }
  };

  const runWorkerRevision = async (
    current: OrchestrationLedger,
    task: OrchestrationTaskState,
    prepared: TaskWorktree,
    review: SelfImprovementReview,
  ): Promise<{ report?: string; error?: string }> => {
    const snapshot = current.revisionPipelineSnapshot;
    if (!snapshot || !current.revisionPipelineId) {
      return { error: "This run carries no immutable revision pipeline snapshot" };
    }
    const room = await manager.createConversation({
      title: `[${task.spec.id}] Revision`,
      pipelineId: current.revisionPipelineId,
      pipelineSnapshot: structuredClone(snapshot),
      workingDirectory: prepared.worktreePath,
      pipelineScopeRoot: current.workspaceRoot,
      orchestrationRunId: current.runId,
      orchestrationTaskId: task.spec.id,
      orchestrationBranch: prepared.branch,
      orchestrationBaseCommit: prepared.baseCommit,
      orchestrationPaths: task.spec.paths,
      ...(current.masterConversationId ? { parentConversationId: current.masterConversationId } : {}),
    });
    releaseRoom(task);
    task.conversationId = room.id;
    activeConversations.add(room.id);
    task.revisionCycles = (task.revisionCycles ?? 0) + 1;
    await save(current);
    try {
      const execution = await manager.runConversation(
        room.id,
        buildRevisionPacket({
          taskId: task.spec.id,
          outcome: task.spec.title,
          details: task.spec.description || task.spec.title,
          paths: task.spec.paths,
          worktreePath: prepared.worktreePath,
          review,
          checks: task.spec.checks,
        }),
        [],
        1,
        {
          pipelineSnapshot: structuredClone(snapshot),
          ...(current.commitMode === undefined ? {} : { commitMode: current.commitMode }),
          writeScope: task.spec.paths.some((entry) => repositoryPathComparisonKey(entry) === "")
            ? "workspace"
            : "task",
        },
      );
      if (execution.pipeline.status !== "completed") {
        return { error: "The revision pipeline was interrupted" };
      }
      return { report: finalAnswerText(execution.pipeline.answers) };
    } finally {
      activeConversations.delete(room.id);
    }
  };

  /*
   * Checks have already passed on this exact tree. The lead reviews that tree, not a stale
   * baseline; a rejection buys one bounded revision, after which the same checks run again and
   * the lead reviews once more. An exhausted budget is a failed task with the review recorded,
   * never a silently integrated candidate.
   */
  const reviewUntilAccepted = async (
    current: OrchestrationLedger,
    task: OrchestrationTaskState,
    prepared: TaskWorktree,
    input: {
      changedFiles: string[];
      checks: VerificationCheckResult[];
      workerReport: string;
      pipelineStatus: "completed" | "interrupted";
    },
  ): Promise<{
    rejected?: TaskExecutionResult;
    changedFiles: string[];
    checks: VerificationCheckResult[];
  }> => {
    const limit = current.maxRevisionCycles ?? 0;
    let changedFiles = input.changedFiles;
    let checks = input.checks;
    let workerReport = input.workerReport;
    const fail = (summary: string, blockers: string[]): {
      rejected: TaskExecutionResult;
      changedFiles: string[];
      checks: VerificationCheckResult[];
    } => {
      task.implementationComplete = false;
      return {
        rejected: {
          status: "failed",
          summary,
          changedFiles,
          checks,
          blockers,
          pipelineStatus: input.pipelineStatus,
        },
        changedFiles,
        checks,
      };
    };

    for (;;) {
      const used = task.revisionCycles ?? 0;
      const final = used >= limit;
      assertRunning(current);
      const reviewed = await runLeadReview(current, task, prepared, {
        changedFiles,
        checks,
        workerReport,
        final,
      });
      if (!reviewed.review) {
        return fail("The lead review did not produce a usable decision.", [reviewed.error ?? "Unknown lead review failure"]);
      }
      if (reviewed.review.verdict === "accept") {
        return { changedFiles, checks };
      }
      const defects = reviewed.review.defects.map((defect) => `${defect.id}: ${defect.statement}`);
      if (final) {
        const reason = limit === 0
          ? "The lead rejected this candidate and this run allows no revision."
          : `The lead rejected this candidate after ${String(used)} revision${used === 1 ? "" : "s"}; the revision budget is exhausted.`;
        return fail(reason, [reason, reviewed.review.summary, ...defects]);
      }

      assertRunning(current);
      const revised = await runWorkerRevision(current, task, prepared, reviewed.review);
      if (revised.report === undefined) {
        return fail("The bounded revision did not complete.", [revised.error ?? "Unknown revision failure"]);
      }
      workerReport = revised.report;
      await worktrees.normalizeTaskNoCommit(prepared);
      try {
        changedFiles = await validateTaskDelta(current, task, prepared);
      } catch (error) {
        return fail(
          "The revision changed files outside its declared control boundary.",
          [error instanceof Error ? error.message : String(error)],
        );
      }
      task.status = "waitingForResources";
      await save(current);
      assertRunning(current);
      const verification = await runIsolatedChecks(
        current,
        prepared.worktreePath,
        `task-${task.spec.id}-${String(task.attempts)}-revision-${String(task.revisionCycles ?? 0)}`,
        task.spec.checks,
        task.spec.checkResources ?? [],
        async () => {
          task.status = "verifying";
          await save(current);
        },
      );
      checks = verification.checks;
      if (verification.sourceChanged) {
        return fail(
          "The task worktree changed while the revision was being verified.",
          ["Task branch, HEAD, index, or worktree state changed during verification"],
        );
      }
      if (checks.some((check) => check.status !== "passed")) {
        return fail("Deterministic verification failed after the bounded revision.", [checkFailureText(checks)]);
      }
    }
  };

  const runTaskAttempt = async (
    current: OrchestrationLedger,
    task: OrchestrationTaskState,
    verificationFailure?: string,
  ): Promise<TaskExecutionResult> => {
    assertRunning(current);
    let prepared = taskWorktree(task, current.commitMode);
    let pipelineStatus: "completed" | "interrupted" = "completed";
    let changedFiles: string[];
    let workerReport = "";

    if (!task.implementationComplete || !prepared) {
      task.status = "running";
      task.attempts += 1;
      task.startedAt ??= new Date().toISOString();
      delete task.lastError;
      prepared = await worktrees.prepareTask(runWorktree(current), task.spec.id);
      task.worktreePath = prepared.worktreePath;
      task.branch = prepared.branch;
      task.baseCommit = prepared.baseCommit;
      setOptionalProperty(task, "baseTree", prepared.baseTree);
      setOptionalProperty(task, "sharedDependencies", prepared.sharedDependencies);
      await save(current);
      assertRunning(current);

      const pipelineSnapshot = task.spec.pipelineSnapshot;
      if (!pipelineSnapshot) {
        throw new Error(
          `Task ${task.spec.id} predates immutable task-pipeline snapshots. Abandon this run and start it again.`,
        );
      }
      const parentConversationId = current.parentConversationId ?? current.masterConversationId;
      const room = await manager.createConversation({
        title: `[${task.spec.id}] ${task.spec.title}${task.attempts > 1 ? ` · attempt ${String(task.attempts)}` : ""}`,
        pipelineId: task.spec.pipelineId,
        pipelineSnapshot,
        workingDirectory: prepared.worktreePath,
        pipelineScopeRoot: current.workspaceRoot,
        orchestrationRunId: current.runId,
        orchestrationTaskId: task.spec.id,
        orchestrationBranch: prepared.branch,
        orchestrationBaseCommit: prepared.baseCommit,
        orchestrationPaths: task.spec.paths,
        ...(parentConversationId ? { parentConversationId } : {}),
      });
      task.conversationId = room.id;
      activeConversations.add(room.id);
      await save(current);

      const pipeline = await manager.runConversation(
        room.id,
        current.mode === "selfImprovement"
          ? buildWorkerPacket({
              taskId: task.spec.id,
              outcome: task.spec.title,
              details: task.spec.description || task.spec.title,
              paths: task.spec.paths,
              evidence: current.generatedTodo?.tasks.find((entry) => entry.id === task.spec.id)?.evidence ?? [],
              dependencies: dependencySummary(current, task),
              checks: task.spec.checks,
              worktreePath: prepared.worktreePath,
              integrationBranch: current.integrationBranch,
              attempt: task.attempts,
              lockedDecisions: improveLockedDecisions(current),
              baselineFailures: configuration().get<string[]>("improveBaselineFailures", []),
              ...(verificationFailure === undefined ? {} : { verificationFailure }),
            })
          : buildTaskPrompt(current, task, verificationFailure),
        [],
        1,
        {
          pipelineSnapshot,
          ...(current.commitMode === undefined ? {} : { commitMode: current.commitMode }),
          writeScope: task.spec.paths.some((entry) => repositoryPathComparisonKey(entry) === "")
            ? "workspace"
            : "task",
        },
      );
      pipelineStatus = pipeline.pipeline.status;
      workerReport = finalAnswerText(pipeline.pipeline.answers);
      if (controller?.signal.aborted) {
        throw new OrchestrationStoppedError();
      }
      if (pipelineStatus !== "completed") {
        task.implementationComplete = false;
        return {
          status: "failed",
          summary: "The pair pipeline was interrupted.",
          changedFiles: await worktrees.changedFiles(prepared),
          checks: [],
          blockers: ["Pipeline interrupted"],
          pipelineStatus,
        };
      }

      await worktrees.normalizeTaskNoCommit(prepared);
      try {
        changedFiles = await validateTaskDelta(current, task, prepared);
      } catch (error) {
        task.implementationComplete = false;
        return {
          status: "failed",
          summary: "The task changed files outside its declared control boundary.",
          changedFiles: await worktrees.changedFiles(prepared),
          checks: [],
          blockers: [error instanceof Error ? error.message : String(error)],
          pipelineStatus,
        };
      }
      task.implementationComplete = true;
      await save(current);
    } else {
      changedFiles = await validateTaskDelta(current, task, prepared);
    }

    task.status = "waitingForResources";
    await save(current);
    assertRunning(current);
    let verification: Awaited<ReturnType<typeof runIsolatedChecks>>;
    try {
      verification = await runIsolatedChecks(
        current,
        prepared.worktreePath,
        `task-${task.spec.id}-${String(task.attempts)}`,
        task.spec.checks,
        task.spec.checkResources ?? [],
        async () => {
          task.status = "verifying";
          await save(current);
        },
      );
    } catch (error) {
      if (error instanceof ResourceAcquireTimeoutError || error instanceof ResourceQuarantinedError) {
        return {
          status: "blocked",
          summary: "Implementation completed, but deterministic verification could not acquire its protected resources.",
          changedFiles,
          checks: [],
          blockers: [error.message],
          pipelineStatus,
        };
      }
      throw error;
    }
    if (controller?.signal.aborted) {
      throw new OrchestrationStoppedError();
    }
    let checks = verification.checks;
    if (verification.sourceChanged) {
      task.implementationComplete = false;
      return {
        status: "failed",
        summary: "The task worktree changed while verification was running.",
        changedFiles: await worktrees.changedFiles(prepared),
        checks,
        blockers: ["Task branch, HEAD, index, or worktree state changed during verification"],
        pipelineStatus,
      };
    }
    if (checks.some((check) => check.status !== "passed")) {
      task.implementationComplete = false;
      return {
        status: "failed",
        summary: "Deterministic verification failed.",
        changedFiles,
        checks,
        blockers: [checkFailureText(checks)],
        pipelineStatus,
      };
    }

    try {
      changedFiles = await validateTaskDelta(current, task, prepared);
    } catch (error) {
      task.implementationComplete = false;
      return {
        status: "failed",
        summary: "The task worktree changed outside its declared scope.",
        changedFiles: await worktrees.changedFiles(prepared),
        checks,
        blockers: [error instanceof Error ? error.message : String(error)],
        pipelineStatus,
      };
    }

    if (current.mode === "selfImprovement") {
      const reviewed = await reviewUntilAccepted(current, task, prepared, {
        changedFiles,
        checks,
        workerReport,
        pipelineStatus,
      });
      if (reviewed.rejected) return reviewed.rejected;
      changedFiles = reviewed.changedFiles;
      checks = reviewed.checks;
    }

    task.status = "integrating";
    await save(current);
    assertRunning(current);
    const commit = await worktrees.commitTask(prepared, task.spec.title);
    setOptionalProperty(task, "commit", commit);
    const result: TaskExecutionResult = {
      status: "done",
      summary: summaryFor(task, changedFiles),
      changedFiles,
      checks,
      blockers: [],
      pipelineStatus,
    };

    await integrateSerially(async () => {
      assertRunning(current);
      const before = await worktrees.integrationCommit(runWorktree(current));
      // Where `before` sits in the run's history. Integration is serialized, so every acceptance
      // counted here is already contained in `before`, and every later one is not.
      const acceptedBefore = acceptedIntegrations(current);
      task.integrationRollbackCommit = before;
      task.integrationRollbackSequence = acceptedBefore;
      try {
        await save(current);
      } catch (error) {
        delete task.integrationRollbackCommit;
        delete task.integrationRollbackSequence;
        throw error;
      }
      try {
        if (commit || (!shouldCreateManagedCommit(current.commitMode) && changedFiles.length > 0)) {
          const integratedState = await worktrees.integrateTask(runWorktree(current), prepared, task.spec.title);
          if (!shouldCreateManagedCommit(current.commitMode)) {
            current.integrationTree = integratedState;
          }
        }
        assertRunning(current);
        await markCompleted(current, task);
        if (!shouldCreateManagedCommit(current.commitMode)) {
          current.integrationTree = await worktrees.integrationCommit(runWorktree(current));
        }
        assertRunning(current);
        task.result = result;
        task.status = "done";
        task.completedAt = new Date().toISOString();
        // One persisted step. A ledger recording `done` while it still named a rollback commit
        // would make the next resume reset the integration tree past work this run accepted.
        delete task.integrationRollbackCommit;
        delete task.integrationRollbackSequence;
        current.acceptedIntegrations = acceptedBefore + 1;
        await save(current);
      } catch (error) {
        // This task's integration is not accepted work whichever way the rollback goes, so the
        // count stays where it was: what a later marker has to be ordered against is the
        // acceptances the run kept, not the ones it took back.
        current.acceptedIntegrations = acceptedBefore;
        try {
          await worktrees.resetIntegration(runWorktree(current), before);
          if (!shouldCreateManagedCommit(current.commitMode)) {
            current.integrationTree = before;
          }
          delete task.integrationRollbackCommit;
          delete task.integrationRollbackSequence;
        } catch (rollbackError) {
          task.integrationRollbackCommit = before;
          task.integrationRollbackSequence = acceptedBefore;
          task.status = "blocked";
          task.completedAt = new Date().toISOString();
          task.lastError = "Integration rollback cleanup was not confirmed";
          const rollbackFailures: unknown[] = [error, rollbackError];
          try {
            await save(current);
          } catch (persistenceError) {
            rollbackFailures.push(persistenceError);
          }
          throw new AggregateError(
            rollbackFailures,
            "Task integration failed and rollback cleanup was not confirmed",
          );
        }
        task.status = controller?.signal.aborted ? "cancelled" : "failed";
        delete task.completedAt;
        throw error;
      }
    });
    return result;
  };

  const executeTask = async (current: OrchestrationLedger, task: OrchestrationTaskState): Promise<void> => {
    let failure: string | undefined;
    try {
      while (!controller?.signal.aborted) {
        const previous = taskWorktree(task, current.commitMode);
        if (previous && !task.implementationComplete) {
          await dependencies.beforeOrchestrationOperation?.(
            "removeTask",
            { runId: current.runId, taskId: task.spec.id },
          );
          await worktrees.removeTask(runWorktree(current), previous);
          delete task.worktreePath;
          delete task.branch;
          delete task.baseCommit;
          delete task.baseTree;
          delete task.commit;
        }
        let result: TaskExecutionResult;
        try {
          result = await runTaskAttempt(current, task, failure);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const rollbackPending = task.integrationRollbackCommit !== undefined;
          result = {
            status: controller?.signal.aborted || error instanceof OrchestrationStoppedError || rollbackPending ? "blocked" : "failed",
            summary: controller?.signal.aborted
              ? "Orchestration was stopped."
              : rollbackPending
                ? "Integration rollback cleanup must be restored before this task can resume."
                : "Task execution failed.",
            changedFiles: taskWorktree(task, current.commitMode)
              ? await worktrees.changedFiles(taskWorktree(task, current.commitMode) as TaskWorktree).catch(() => [])
              : [],
            checks: [],
            blockers: [message],
          };
        }
        task.result = result;
        if (result.status === "done") {
          releaseRoom(task);
          const prepared = taskWorktree(task, current.commitMode);
          if (prepared) {
            await worktrees.removeTask(runWorktree(current), prepared);
          }
          delete task.worktreePath;
          delete task.branch;
          delete task.baseCommit;
          delete task.baseTree;
          task.implementationComplete = false;
          await save(current);
          return;
        }
        failure = result.blockers.join("\n\n") || result.summary;
        task.lastError = failure;
        releaseRoom(task);
        if (controller?.signal.aborted) {
          task.status = "cancelled";
          task.completedAt = new Date().toISOString();
          await save(current);
          return;
        }
        if (result.status === "blocked" || result.status === "needsHuman") {
          task.status = "blocked";
          task.completedAt = new Date().toISOString();
          await save(current);
          return;
        }
        task.implementationComplete = false;
        if (task.attempts > task.spec.retries) {
          task.status = "failed";
          task.completedAt = new Date().toISOString();
          await save(current);
          return;
        }
        delete task.conversationId;
        task.status = "pending";
        await save(current);
      }
      task.status = "cancelled";
      task.lastError = "Orchestration was stopped";
      task.completedAt = new Date().toISOString();
      await save(current);
    } finally {
      if (task.conversationId) {
        activeConversations.delete(task.conversationId);
      }
    }
  };

  const runFinalChecks = async (current: OrchestrationLedger): Promise<void> => {
    const commands = Array.from(new Set(
      current.finalCheckCommands ?? Object.values(current.tasks).flatMap((task) => task.spec.finalChecks ?? []),
    ));
    const resources = Array.from(new Set(
      current.finalCheckResources ?? Object.values(current.tasks).flatMap((task) => task.spec.finalCheckResources ?? []),
    ));
    // EX-A5-R01. Read before the checks are composed, so the evidence is labelled with the HEAD
    // they actually ran against rather than with whatever the branch has become by the time they
    // finish. A run's final checks are authorized against the commit the run started from; a
    // branch that has already moved leaves them evidence about a composition nobody asked for,
    // and the recovery is an explicit recheck rather than a relabelling.
    const targetBeforeChecks = await readTargetHead(current);
    const authorizedTarget = targetDriftRefusal(current, targetBeforeChecks) === undefined;
    try {
      const verification = await runIsolatedChecks(
        current,
        current.integrationWorktree,
        "final",
        commands,
        resources,
      );
      current.finalChecks = verification.checks;
      // P3. A run that finished with passing checks has verified its own retained candidate, so
      // Apply does not need a rerun until that candidate changes.
      // EX-A5-R01. Only while the branch it ran against is still the branch the run was
      // authorized against, and is still where it was when the checks began.
      if (current.finalChecks.every((check) => check.status === "passed")
        && !verification.sourceChanged
        && authorizedTarget
        && await readTargetHead(current) === targetBeforeChecks) {
        const fingerprint = retainedFingerprint(current);
        current.retainedEvidence = withRetainedEvidence(current.retainedEvidence, {
          fingerprint,
          checks: current.finalChecks.map((check) => ({ ...check, candidateTree: fingerprint })),
          target: targetBeforeChecks,
        });
      }
      if (current.finalChecks.some((check) => check.status !== "passed") || verification.sourceChanged) {
        current.status = controller?.signal.aborted ? "stopped" : "failed";
        current.error = controller?.signal.aborted
          ? "Stopped by the user"
          : current.finalChecks.some((check) => check.status !== "passed")
            ? `Integration verification failed\n${checkFailureText(current.finalChecks)}`
            : "Integration branch, HEAD, index, or worktree state changed during verification";
      }
    } catch (error) {
      if (error instanceof ResourceAcquireTimeoutError || error instanceof ResourceQuarantinedError) {
        current.status = "blocked";
        current.error = `Final verification is blocked: ${error.message}`;
        return;
      }
      throw error;
    }
  };

  const runLoop = async (current: OrchestrationLedger): Promise<OrchestrationLedger> => {
    const active = new Map<string, Promise<void>>();
    let observedMasterState = "";
    // EX-G6-05 / EX-A5-R12. The first unexpected task-operation rejection, kept until the loop
    // consumes it. `Promise.race(active.values())` settles on whichever operation settles first, so
    // a rejection landing in the same tick as a sibling's resolution could otherwise be observed by
    // the race, discarded in favour of the sibling, and leave the loop selecting a terminal status
    // with no error. Retaining it and re-raising it here, before any further scheduling or terminal
    // selection, routes it to the drain path deterministically while preserving stop precedence.
    let pendingTaskRejection: { error: unknown } | undefined;
    current.status = "running";
    await save(current);
    try {
      while (!controller?.signal.aborted) {
        if (pendingTaskRejection) {
          const raised = pendingTaskRejection.error;
          pendingTaskRejection = undefined;
          throw raised;
        }
        if (active.size === 0) {
          const beforeSchedule = terminalLedgerStatus(current);
          if (beforeSchedule !== "failed" && beforeSchedule !== "blocked") {
            const fingerprint = masterStateFingerprint(current);
            if (fingerprint !== observedMasterState) {
              const check = await runMasterCheck(
                current,
                beforeSchedule === "completed" ? "terminal" : "schedule",
              );
              observedMasterState = fingerprint;
              if (check.status === "deviation") {
                current.status = "blocked";
                current.error = `Master reported execution deviation: ${check.deviations
                  .map((item) => `${item.taskId}/${item.kind}: ${item.details}`)
                  .join("; ")}`;
                break;
              }
            }
          }
        }
        const runnable = selectRunnableTasks(current);
        runnable.forEach((task) => {
          if (active.has(task.spec.id)) {
            return;
          }
          const taskOperation = executeTask(current, task)
            // Retain the first unexpected rejection rather than letting Promise.race decide whether
            // it survives a sibling's resolution; the loop consumes it before scheduling anything
            // further. Draining of the still-active siblings stays in the catch below.
            .catch((error: unknown) => {
              pendingTaskRejection ??= { error };
            })
            .finally(() => active.delete(task.spec.id));
          active.set(task.spec.id, taskOperation);
        });
        if (active.size > 0) {
          await Promise.race(active.values());
          continue;
        }
        const terminal = terminalLedgerStatus(current);
        if (!terminal) {
          current.status = "blocked";
          current.error = "No task is runnable. Check dependencies and path scopes.";
          break;
        }
        current.status = terminal;
        break;
      }
      if (controller?.signal.aborted) {
        current.status = "stopped";
        current.error = "Stopped by the user";
        await Promise.allSettled(active.values());
      } else if (current.status === "completed") {
        await runFinalChecks(current);
      }
    } catch (error) {
      if (controller?.signal.aborted || error instanceof OrchestrationStoppedError) {
        current.status = "stopped";
        current.error = "Stopped by the user";
        await Promise.allSettled(active.values());
      } else {
        current.status = "failed";
        current.error = `TODO orchestration failed: ${error instanceof Error ? error.message : String(error)}`;
        // EX-G6-05. The stop path above drains the tasks that are still running, and an
        // unexpected failure has to do the same. Marking the run failed and then removing its
        // worktrees while sibling tasks are still driving providers into those worktrees
        // releases ownership over work that has not stopped: the cleanup races the writes, and
        // whatever survives it belongs to a run that is already recorded as finished.
        controller?.abort();
        await Promise.allSettled(active.values());
      }
    }
    try {
      await worktrees.cleanupRun(runWorktree(current));
    } catch (error) {
      current.status = "failed";
      current.error = `TODO Git cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    await save(current);
    if (current.status === "completed") {
      await store.setActiveRun(undefined);
    } else {
      await store.setActiveRun(current.runId);
    }
    return current;
  };

  const begin = (current: OrchestrationLedger): Promise<OrchestrationLedger> => {
    if (operation || !startupClaimed) {
      throw new Error("TODO orchestration is already active");
    }
    ledger = current;
    const runController = new AbortController();
    controller = runController;
    const currentOperation = runLoop(current).finally(async () => {
      if (operation === currentOperation) {
        operation = undefined;
      }
      if (controller === runController) {
        controller = undefined;
      }
      await releaseOrchestrationOwner();
      emit();
    });
    operation = currentOperation;
    startupClaimed = false;
    emit();
    return currentOperation;
  };

  const assertNoRecoverableRun = async (): Promise<void> => {
    await initialization;
    const activeRunId = await store.getActiveRun();
    if (!activeRunId) {
      return;
    }
    const activeRun = await store.load(activeRunId);
    if (activeRun.status === "completed" || activeRun.status === "abandoned") {
      await store.setActiveRun(undefined);
      return;
    }
    throw new Error("A recoverable TODO run already exists. Resume or abandon it first.");
  };

  const cleanupNewRun = async (input: {
    master?: Awaited<ReturnType<typeof createMasterConversation>>;
    prepared?: RunWorktree;
    persisted: boolean;
    activePointerWritten: boolean;
  }): Promise<void> => {
    if (input.prepared) {
      await worktrees.abandonRun(input.prepared);
    }
    if (input.activePointerWritten && input.master) {
      const activeRunId = await store.getActiveRun();
      if (activeRunId === input.master.runId) {
        await store.setActiveRun(undefined);
      }
    }
    if (input.master) {
      await manager.closeConversation(input.master.conversationId);
      if (input.persisted) {
        await store.remove(input.master.runId);
      }
    }
  };

  /*
   * Resolved once per run and stored immutably beside the task pipeline, exactly like the
   * Master snapshot: the controller-owned review and revision turns must not silently change
   * definition while a run is in flight or between a stop and its resume.
   */
  const resolveImprovePipelines = async (
    conversationId: string,
  ): Promise<{
    reviewPipelineId: string;
    reviewPipelineSnapshot: PipelineSnapshot;
    revisionPipelineId: string;
    revisionPipelineSnapshot: PipelineSnapshot;
  }> => {
    const ids = selfImprovementPipelineIds();
    const [reviewPipelineSnapshot, revisionPipelineSnapshot] = await Promise.all([
      manager.resolvePipelineSnapshot(conversationId, ids.review, {
        requireCurrentCatalog: true,
        unattended: true,
        rejectChecklist: true,
      }),
      manager.resolvePipelineSnapshot(conversationId, ids.revision, {
        requireCurrentCatalog: true,
        unattended: true,
        rejectChecklist: true,
      }),
    ]);
    return {
      reviewPipelineId: ids.review,
      reviewPipelineSnapshot,
      revisionPipelineId: ids.revision,
      revisionPipelineSnapshot,
    };
  };

  const startFromTodo = async (
    options: {
      sealedInputPaths?: string[];
      mode: OrchestrationLedger["mode"];
      // EX-A5-R06. The repository this operation was approved against. Frozen by the caller and
      // threaded through readiness, execution selection, ownership and worktree creation, because
      // reacquiring it from the active editor after approval executes whichever repository the
      // editor has since moved to.
      workspaceRoot?: string;
    },
  ): Promise<OrchestrationLedger> => {
    if (disposed) {
      throw new Error("TODO orchestrator is disposed");
    }
    if (!dependencies.isWorkspaceTrusted()) {
      throw new Error("Trust the workspace before running TODO orchestration");
    }
    claimStartup();
    let began = false;
    let master: Awaited<ReturnType<typeof createMasterConversation>> | undefined;
    let prepared: RunWorktree | undefined;
    let persisted = false;
    let activePointerWritten = false;
    let retainUnsafeOwner = false;
    try {
      const root = options.workspaceRoot ?? workspaceRoot();
      assertStartupNotCancelled();
      await acquireOrchestrationOwner(root, "start TODO orchestration");
      assertStartupNotCancelled();
      await assertNoRecoverableRun();
      const todoName = configuration().get<string>("todoFile", "TODO.md");
      const canonicalRoot = await canonicalizePath(root);
      const todoPath = await canonicalizePath(path.resolve(root, todoName));
      const todoRelativeToWorkspace = path.relative(canonicalRoot, todoPath);
      if (
        !todoRelativeToWorkspace ||
        todoRelativeToWorkspace.startsWith("..") ||
        path.isAbsolute(todoRelativeToWorkspace)
      ) {
        throw new Error("The configured TODO file must be inside the workspace folder");
      }
      const source = await readFile(todoPath, "utf8");
      const parsed = parseTodoDocument(todoPath, source, {
        pipelineId: defaultTaskPipelineId(options.mode),
        retries: configuration().get<number>("todoRetries", 1),
        requirePaths: true,
        requireControllerVerification: true,
      });
      if (parsed.tasks.length === 0) {
        throw new Error(`No checkbox tasks were found in ${todoName}`);
      }
      if (configuration().get<boolean>("todoRequireChecks", true)) {
        const uncheckedWithoutChecks = parsed.tasks.filter(
          (task) => !task.completed && !task.checksDeclared,
        );
        if (uncheckedWithoutChecks.length > 0) {
          throw new Error(
            `Every incomplete TODO task must declare Verify or Verify: none. Missing: ${uncheckedWithoutChecks.map((task) => task.id).join(", ")}`,
          );
        }
      }
      const readableTitle = options.mode === "selfImprovement"
        ? `Improve · ${path.basename(root)}`
        : `TODO · ${path.basename(root)}`;
      master = await createMasterConversation({ title: readableTitle });
      const improvePipelines = options.mode === "selfImprovement"
        ? await resolveImprovePipelines(master.conversationId)
        : undefined;
      const taskPipelineSnapshots = new Map<string, PipelineSnapshot>();
      for (const task of parsed.tasks.filter((candidate) => !candidate.completed)) {
        if (!taskPipelineSnapshots.has(task.pipelineId)) {
          taskPipelineSnapshots.set(
            task.pipelineId,
            await manager.resolvePipelineSnapshot(
              master.conversationId,
              task.pipelineId,
              {
                requireCurrentCatalog: true,
                unattended: true,
                rejectChecklist: true,
              },
            ),
          );
        }
      }
      const taskSpecs = parsed.tasks.map((task) => {
        const pipelineSnapshot = taskPipelineSnapshots.get(task.pipelineId);
        return {
          ...task,
          ...(pipelineSnapshot === undefined ? {} : { pipelineSnapshot }),
        };
      });
      const requestedCommitMode: ManagedCommitMode = "never";
      assertStartupNotCancelled();
      prepared = await worktrees.prepareRun(
        root,
        master.runId,
        [],
        requestedCommitMode,
        options.sealedInputPaths ?? [],
      );
      await relativeTodoPath(prepared.repositoryRoot, todoPath);
      const now = new Date().toISOString();
      const current: OrchestrationLedger = {
        version: 1,
        runId: master.runId,
        title: formatRunTitle(master.runId, readableTitle),
        status: "preparing",
        workspaceRoot: prepared.repositoryRoot,
        ownerWorkspaceRoot: path.resolve(root),
        sourceKind: "todoFile",
        mode: options.mode ?? "todo",
        repositoryVerifierAuthority: repositoryVerifierAuthorityFor(options.mode, path.resolve(root)),
        ...(improvePipelines ?? {}),
        ...(options.mode === "selfImprovement" ? { maxRevisionCycles: maxRevisionCycles() } : {}),
        todoPath,
        todoSourceHash: parsed.sourceHash,
        integrationBranch: prepared.integrationBranch,
        integrationWorktree: prepared.integrationWorktree,
        baselineCommit: prepared.baselineCommit,
        ...(prepared.inputTree ? { inputTree: prepared.inputTree } : {}),
        ...(prepared.sealedInputPaths ? { sealedInputPaths: [...prepared.sealedInputPaths] } : {}),
        ...(prepared.integrationTree ? { integrationTree: prepared.integrationTree } : {}),
        commitMode: prepared.commitMode,
        createdAt: now,
        updatedAt: now,
        maxConcurrency: Math.max(1, configuration().get<number>("todoMaxConcurrency", 2)),
        masterConversationId: master.conversationId,
        masterPipelineId: master.pipelineId,
        masterPipelineSnapshot: master.pipelineSnapshot,
        masterChecks: [],
        tasks: Object.fromEntries(taskSpecs.map((spec) => [
          spec.id,
          {
            spec,
            status: spec.completed ? "done" : "pending",
            attempts: 0,
            ...(spec.completed
              ? {
                  completedAt: now,
                  result: {
                    status: "done",
                    summary: "Already completed before this run.",
                    changedFiles: [],
                    checks: [],
                    blockers: [],
                  },
                }
              : {}),
          },
        ])),
        finalChecks: [],
        finalCheckCommands: Array.from(new Set(taskSpecs.flatMap((task) => task.finalChecks ?? []))),
        finalCheckResources: Array.from(new Set(taskSpecs.flatMap((task) => task.finalCheckResources ?? []))),
      };
      assertStartupNotCancelled();
      await store.save(current);
      persisted = true;
      assertStartupNotCancelled();
      await store.setActiveRun(current.runId);
      activePointerWritten = true;
      assertStartupNotCancelled();
      began = true;
      return begin(current);
    } catch (error) {
      try {
        await cleanupNewRun({
          ...(master === undefined ? {} : { master }),
          ...(prepared === undefined ? {} : { prepared }),
          persisted,
          activePointerWritten,
        });
      } catch (cleanupError) {
        retainUnsafeOwner = true;
        await failUnsafeStartupRollback(
          error,
          cleanupError,
          "TODO startup and rollback both failed",
        );
      }
      throw error;
    } finally {
      releaseStartup();
      if (!began && !retainUnsafeOwner) {
        await releaseOrchestrationOwner();
      }
    }
  };

  const configuredTodoLocation = async (root: string): Promise<{ name: string; path: string }> => {
    const todoName = configuration().get<string>("todoFile", "TODO.md");
    const canonicalRoot = await canonicalizePath(root);
    const todoPath = await canonicalizePath(path.resolve(root, todoName));
    const relative = path.relative(canonicalRoot, todoPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("The configured TODO file must be inside the workspace folder");
    }
    return { name: todoName, path: todoPath };
  };

  /*
   * The one question that decides which Improve path runs. A TODO that is missing, empty, or
   * refused by the executable parser is audit context, never executable input.
   */
  const todoExecutability = async (
    root: string,
  ): Promise<{ executable: boolean; diagnostic?: string }> => {
    try {
      const location = await configuredTodoLocation(root);
      const source = await readFile(location.path, "utf8");
      const parsed = parseTodoDocument(location.path, source, {
        pipelineId: defaultTaskPipelineId("selfImprovement"),
        retries: configuration().get<number>("todoRetries", 1),
        requirePaths: true,
        requireControllerVerification: true,
      });
      const incomplete = parsed.tasks.filter((task) => !task.completed);
      if (incomplete.length === 0) {
        return { executable: false, diagnostic: `${location.name} declares no incomplete task` };
      }
      if (configuration().get<boolean>("todoRequireChecks", true)) {
        const missing = incomplete.filter((task) => !task.checksDeclared);
        if (missing.length > 0) {
          return {
            executable: false,
            diagnostic: `${location.name} tasks declare no Verify: ${missing.map((task) => task.id).join(", ")}`,
          };
        }
      }
      return { executable: true };
    } catch (error) {
      return {
        executable: false,
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const approvedVerifierCommands = async (root: string): Promise<string[]> => {
    if (repositoryVerifierApprovalFor("selfImprovement", root).authority !== "humanApproved") return [];
    const load = await loadVerifierRegistry(root);
    if (!load.present || load.errors.length > 0 || !load.registry) return [];
    return load.registry.verifiers.map((descriptor) => `bachata:verifier:${descriptor.id}`);
  };

  const acceptedConvergenceCandidate = (
    decisions: Record<string, Array<{ status: string; candidate?: JsonValue; candidateHash?: string; candidateId?: string }>>,
  ): { candidate?: JsonValue; candidateHash: string; candidateId: string; ruling: "accepted" | "ruled"; error?: string } => {
    const artifacts = decisions["plan-convergence"] ?? [];
    const accepted = [...artifacts]
      .reverse()
      .find((artifact) => artifact.status === "accepted" || artifact.status === "ruled");
    if (!accepted || accepted.candidate === undefined) {
      return {
        candidateHash: "",
        candidateId: "",
        ruling: "accepted",
        error: "Discovery produced no accepted convergence candidate",
      };
    }
    return {
      candidate: accepted.candidate,
      candidateHash: accepted.candidateHash ?? "",
      candidateId: accepted.candidateId ?? "",
      ruling: accepted.status === "ruled" ? "ruled" : "accepted",
    };
  };

  const runDiscoveryConversation = async (
    root: string,
    prepared: RunWorktree,
    master: Awaited<ReturnType<typeof createMasterConversation>>,
    pipelineId: string,
    title: string,
    prompt: string,
  ): Promise<Awaited<ReturnType<ConversationManager["runConversation"]>>> => {
    const room = await manager.createConversation({
      title,
      pipelineId,
      // The agent's session is rooted at the checked-out candidate, and the prompt names that
      // same path as the one tree to read. Advertising the logical repository root instead is
      // what once let a participant read nothing and still report completion.
      workingDirectory: prepared.integrationWorktree,
      pipelineScopeRoot: path.resolve(root),
      orchestrationRunId: master.runId,
      parentConversationId: master.conversationId,
    });
    activeConversations.add(room.id);
    try {
      const snapshot = await manager.resolvePipelineSnapshot(room.id, pipelineId, {
        requireCurrentCatalog: true,
        unattended: true,
        rejectChecklist: true,
      });
      const execution = await manager.runConversation(room.id, prompt, [], 1, {
        pipelineSnapshot: snapshot,
        commitMode: "never",
        writeScope: "readOnly",
      });
      if (execution.pipeline.status !== "completed") {
        throw new Error(`${pipelineId} was interrupted`);
      }
      return execution;
    } finally {
      activeConversations.delete(room.id);
    }
  };

  const runDiscovery = async (
    root: string,
    prepared: RunWorktree,
    master: Awaited<ReturnType<typeof createMasterConversation>>,
    taskPipelineId: string,
  ): Promise<{
    plan: SelfImprovementPlan;
    audits: RepositoryAudit[];
    conversationId: string;
    candidateHash: string;
    candidateId: string;
    ruling: "accepted" | "ruled";
  }> => {
    const ids = selfImprovementPipelineIds();
    const candidate: CandidateIdentity = {
      repositoryRoot: prepared.repositoryRoot,
      baselineCommit: prepared.baselineCommit,
      ...(prepared.inputTree ? { inputTree: prepared.inputTree } : {}),
      candidateWorktree: prepared.integrationWorktree,
    };
    const constraints = {
      candidate,
      pipelineId: taskPipelineId,
      retries: configuration().get<number>("todoRetries", 1),
      controllerChecks: ["bachata:workspace-integrity", "bachata:project-checks"],
      approvedVerifierCommands: await approvedVerifierCommands(root),
    };

    const auditRun = await runDiscoveryConversation(
      root,
      prepared,
      master,
      ids.discovery,
      "Improve · independent audit",
      buildDiscoveryPrompt(constraints),
    );
    const auditArtifacts = auditRun.pipeline.outputs["independent-audit"] ?? {};
    const audits: RepositoryAudit[] = [];
    const auditErrors: string[] = [];
    Object.entries(auditArtifacts).forEach(([agentId, artifact]) => {
      if (artifact.validationErrors.length > 0) {
        auditErrors.push(`${agentId}: ${artifact.validationErrors.join("; ")}`);
        return;
      }
      const parsed = parseRepositoryAudit(agentId, artifact.value as JsonValue);
      if (!parsed.audit) {
        auditErrors.push(parsed.errors.join("; "));
        return;
      }
      audits.push(parsed.audit);
    });
    // The gate is the controller's, and it closes before convergence exists. A transport that
    // completed is not an audit that happened.
    const gate = [...auditErrors, ...auditGateErrors(audits)];
    if (gate.length > 0) {
      throw new Error(`Independent discovery did not happen: ${gate.join("; ")}`);
    }

    const convergenceRun = await runDiscoveryConversation(
      root,
      prepared,
      master,
      ids.convergence,
      "Improve · convergence",
      buildConvergencePrompt({ ...constraints, audits }),
    );
    const accepted = acceptedConvergenceCandidate(convergenceRun.pipeline.decisions);
    if (accepted.error !== undefined || accepted.candidate === undefined) {
      throw new Error(accepted.error ?? "Discovery produced no accepted convergence candidate");
    }
    const parsed = parseSelfImprovementPlan(accepted.candidate, {
      retries: configuration().get<number>("todoRetries", 1),
    });
    if (!parsed.plan) {
      throw new Error(`The accepted convergence candidate is not an executable plan: ${parsed.errors.join("; ")}`);
    }
    return {
      plan: parsed.plan,
      audits,
      conversationId: convergenceRun.conversationId,
      candidateHash: accepted.candidateHash,
      candidateId: accepted.candidateId,
      ruling: accepted.ruling,
    };
  };

  const startGeneratedPlan = async (
    options: { sealedInputPaths?: string[]; workspaceRoot?: string } = {},
  ): Promise<OrchestrationLedger> => {
    if (disposed) {
      throw new Error("TODO orchestrator is disposed");
    }
    if (!dependencies.isWorkspaceTrusted()) {
      throw new Error("Trust the workspace before running self-improvement");
    }
    claimStartup();
    let began = false;
    let master: Awaited<ReturnType<typeof createMasterConversation>> | undefined;
    let prepared: RunWorktree | undefined;
    let persisted = false;
    let activePointerWritten = false;
    let retainUnsafeOwner = false;
    try {
      const root = options.workspaceRoot ?? workspaceRoot();
      assertStartupNotCancelled();
      await acquireOrchestrationOwner(root, "start self-improvement orchestration");
      assertStartupNotCancelled();
      await assertNoRecoverableRun();
      const ids = selfImprovementPipelineIds();
      const readableTitle = `Improve · ${path.basename(root)}`;
      master = await createMasterConversation({ title: readableTitle });
      const improvePipelines = await resolveImprovePipelines(master.conversationId);
      const taskPipelineSnapshot = await manager.resolvePipelineSnapshot(
        master.conversationId,
        ids.task,
        { requireCurrentCatalog: true, unattended: true, rejectChecklist: true },
      );
      assertStartupNotCancelled();
      prepared = await worktrees.prepareRun(
        root,
        master.runId,
        [],
        "never",
        options.sealedInputPaths ?? [],
      );
      assertStartupNotCancelled();
      const discovery = await runDiscovery(root, prepared, master, ids.task);
      assertStartupNotCancelled();

      const plan = discovery.plan;
      if (plan.tasks.length === 0 && plan.blockers.length === 0) {
        throw new Error("Discovery confirmed no executable work and named no decision a human owns");
      }
      const registryLoad = await loadVerifierRegistry(prepared.integrationWorktree);
      const repositoryErrors = planRepositoryErrors(plan, {
        declaredVerifierIds: registryLoad.errors.length === 0
          ? (registryLoad.registry?.verifiers ?? []).map((descriptor) => descriptor.id)
          : [],
        repositoryVerifiersApproved:
          repositoryVerifierAuthorityFor("selfImprovement", path.resolve(root)) === "humanApproved",
        pathExists: (relativePath) =>
          existsSync(path.join(prepared?.integrationWorktree as string, ...relativePath.split("/"))),
      });
      if (repositoryErrors.length > 0) {
        throw new Error(
          `The accepted plan does not hold against this repository: ${repositoryErrors.join("; ")}`,
        );
      }
      const issues = selfImprovementIssues(plan);
      const generatedScope = plan.tasks.length > 0
        ? validateGeneratedTasks(issues, { authority: "plan" })
        : { issuePaths: new Map<string, string[]>(), allowedPaths: ["."] };
      const todoSource = renderExecutableTodo(plan, {
        pipelineId: ids.task,
        candidate: {
          repositoryRoot: prepared.repositoryRoot,
          baselineCommit: prepared.baselineCommit,
          ...(prepared.inputTree ? { inputTree: prepared.inputTree } : {}),
          candidateWorktree: prepared.integrationWorktree,
        },
      });
      // The rendered plan is parsed back with the same parser `Bachata: Run TODO.md` uses. A plan
      // that cannot be expressed as an executable TODO never reaches a worker.
      let reparsed;
      try {
        reparsed = parseTodoDocument(path.join(prepared.repositoryRoot, "BACHATA_IMPROVE.md"), todoSource, {
          pipelineId: ids.task,
          retries: configuration().get<number>("todoRetries", 1),
          requirePaths: true,
          requireControllerVerification: true,
        });
      } catch (error) {
        throw new Error(
          `The generated TODO is not executable: ${error instanceof Error ? error.message : String(error)}\n\n${todoSource}`,
        );
      }
      const renderedIds = reparsed.tasks.map((task) => task.id).sort();
      const plannedIds = plan.tasks.map((task) => task.id).sort();
      if (JSON.stringify(renderedIds) !== JSON.stringify(plannedIds)) {
        throw new Error("The generated TODO did not round-trip to the accepted plan tasks");
      }
      const generatedTodoPath = await generatedTodoTarget(root, prepared.integrationWorktree);
      const humanDecisionBlockers = plan.blockers.map(
        (blocker) => `${blocker.subject}: ${blocker.question} (${blocker.evidence.join(", ")})`,
      );
      const generatedTodo: GeneratedTodoPlan = {
        source: todoSource,
        audits: discovery.audits.map((audit) => ({
          agentId: audit.agentId,
          status: audit.status,
          ...(audit.blockedReason ? { blockedReason: audit.blockedReason } : {}),
          inspected: audit.inspected,
          findingCount: audit.findings.length,
        })),
        candidateId: discovery.candidateId,
        candidateHash: discovery.candidateHash,
        ruling: discovery.ruling,
        discoveryConversationId: discovery.conversationId,
        title: plan.title,
        summary: plan.summary,
        evidence: plan.evidence,
        blockers: plan.blockers,
        tasks: plan.tasks,
      };

      const now = new Date().toISOString();
      const retries = configuration().get<number>("todoRetries", 1);
      const current: OrchestrationLedger = {
        version: 1,
        runId: master.runId,
        title: formatRunTitle(master.runId, readableTitle),
        status: "preparing",
        workspaceRoot: prepared.repositoryRoot,
        ownerWorkspaceRoot: path.resolve(root),
        sourceKind: "generatedChecklist",
        mode: "selfImprovement",
        repositoryVerifierAuthority: repositoryVerifierAuthorityFor("selfImprovement", path.resolve(root)),
        ...improvePipelines,
        maxRevisionCycles: maxRevisionCycles(),
        generatedTodo,
        generatedTodoPath,
        ...(humanDecisionBlockers.length > 0 ? { humanDecisionBlockers } : {}),
        generatedAllowedPaths: generatedScope.allowedPaths,
        integrationBranch: prepared.integrationBranch,
        integrationWorktree: prepared.integrationWorktree,
        baselineCommit: prepared.baselineCommit,
        ...(prepared.inputTree ? { inputTree: prepared.inputTree } : {}),
        ...(prepared.sealedInputPaths ? { sealedInputPaths: [...prepared.sealedInputPaths] } : {}),
        ...(prepared.integrationTree ? { integrationTree: prepared.integrationTree } : {}),
        commitMode: prepared.commitMode,
        createdAt: now,
        updatedAt: now,
        maxConcurrency: Math.max(1, configuration().get<number>("todoMaxConcurrency", 2)),
        masterConversationId: master.conversationId,
        masterPipelineId: master.pipelineId,
        masterPipelineSnapshot: master.pipelineSnapshot,
        masterChecks: [],
        tasks: Object.fromEntries(plan.tasks.map((task, index) => [
          task.id,
          {
            spec: {
              id: task.id,
              title: task.outcome,
              description: task.details,
              completed: false,
              line: index + 1,
              explicitId: true,
              dependsOn: [...task.dependsOn],
              pipelineId: ids.task,
              pipelineSnapshot: structuredClone(taskPipelineSnapshot),
              paths: generatedScope.issuePaths.get(task.id) as string[],
              checks: [...task.checks],
              checksDeclared: true,
              checkResources: [],
              finalChecks: [...task.finalChecks],
              finalChecksDeclared: true,
              finalCheckResources: [],
              priority: task.priority,
              retries: Math.max(0, Math.min(10, task.retries ?? retries)),
            },
            status: "pending",
            attempts: 0,
          } satisfies OrchestrationTaskState,
        ])),
        finalChecks: [],
        finalCheckCommands: Array.from(new Set(plan.tasks.flatMap((task) => task.finalChecks))),
        finalCheckResources: [],
      };
      assertStartupNotCancelled();
      // Written into the run's own integration worktree and committed there, so the plan Bachata
      // executed is part of the retained result and reaches the human through Apply.
      await writeGeneratedTodo(current, todoSource);
      assertStartupNotCancelled();
      // A plan that leaves a human-owned judgment open is persisted with its evidence and its
      // exact question, and stops before implementation. It is never answered on Bachata's behalf,
      // and Resume refuses it rather than restarting the question as work.
      if (humanDecisionBlockers.length > 0) {
        current.status = "blocked";
        current.error = `Self-improvement stopped before implementation. Decisions a human owns: ${humanDecisionBlockers.join("; ")}`;
      }
      await store.save(current);
      persisted = true;
      assertStartupNotCancelled();
      await store.setActiveRun(current.runId);
      activePointerWritten = true;
      assertStartupNotCancelled();
      if (current.status === "blocked") {
        ledger = current;
        retainedLedgers.delete(current.runId);
        emit();
        return current;
      }
      began = true;
      return begin(current);
    } catch (error) {
      try {
        await cleanupNewRun({
          ...(master === undefined ? {} : { master }),
          ...(prepared === undefined ? {} : { prepared }),
          persisted,
          activePointerWritten,
        });
      } catch (cleanupError) {
        retainUnsafeOwner = true;
        await failUnsafeStartupRollback(
          error,
          cleanupError,
          "Self-improvement startup and rollback both failed",
        );
      }
      throw error;
    } finally {
      releaseStartup();
      if (!began && !retainUnsafeOwner) {
        await releaseOrchestrationOwner();
      }
    }
  };

  const improve = async (
    options: { sealedInputPaths?: string[]; workspaceRoot?: string } = {},
  ): Promise<ImproveOutcome> => {
    if (disposed) {
      throw new Error("TODO orchestrator is disposed");
    }
    if (!dependencies.isWorkspaceTrusted()) {
      throw new Error("Trust the workspace before running self-improvement");
    }
    // EX-G6-08. The caller names the repository it showed, approved and persisted against. A
    // window can hold more than one, and the one this window resolves is the active editor's —
    // which can have moved between the approval and this call. Running the other repository is
    // the failure, so a disagreement stops here rather than being resolved silently.
    // EX-A5-R06. Resolved once, here, and never read from the editor again. The check below is
    // what refuses a window whose editor has already moved; everything after it uses this one
    // value, so a move *during* the asynchronous work that follows cannot select another
    // repository to execute.
    const operationRoot = options.workspaceRoot ?? workspaceRoot();
    if (options.workspaceRoot !== undefined) {
      await assertSameRepository(workspaceRoot(), options.workspaceRoot);
    }
    const executability = await todoExecutability(operationRoot);
    return executability.executable
      ? {
          ledger: await startFromTodo({
            ...options,
            mode: "selfImprovement",
            workspaceRoot: operationRoot,
          }),
          path: "existingTodo",
        }
      : {
          ledger: await startGeneratedPlan({ ...options, workspaceRoot: operationRoot }),
          path: "generatedPlan",
        };
  };

  const readinessStatus = (findings: ReadinessFinding[]): ReadinessStatus => {
    const rank: Record<ReadinessStatus, number> = { ready: 0, needsSetup: 1, blocked: 2, unsupported: 3 };
    return findings.reduce<ReadinessStatus>(
      (result, item) => rank[item.status] > rank[result] ? item.status : result,
      "ready",
    );
  };

  const inspectStartReadiness = async (
    options: {
      sealedInputPaths?: string[];
      mode?: OrchestrationLedger["mode"];
      /** EX-A5-R06. Readiness answers about the repository the operation will execute in. */
      workspaceRoot?: string;
    } = {},
  ): Promise<TodoStartReadiness> => {
    const masterPipelineId = configuration().get<string>("todoMasterPipeline", "todo-master");
    const findings: ReadinessFinding[] = [];
    let contract: OrchestrationContract | undefined;
    const add = (
      id: string,
      label: string,
      status: ReadinessStatus,
      detail: string,
      remediationId?: ReadinessFinding["remediationId"],
    ): void => {
      findings.push({ id, label, status, detail, ...(remediationId ? { remediationId } : {}) });
    };
    const message = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    // EX-G6-08. Resolved once, and reported, so the caller approves and displays the repository
    // this readiness actually describes rather than resolving one of its own.
    let resolvedRoot: string | undefined;
    const result = (): TodoStartReadiness => ({
      pipelineId: masterPipelineId,
      status: readinessStatus(findings),
      findings,
      ...(contract ? { contract } : {}),
      ...(resolvedRoot === undefined ? {} : { workspaceRoot: resolvedRoot }),
    });

    if (disposed) {
      add("todo.orchestrator", "TODO orchestration", "blocked", "TODO orchestration is unavailable");
      return result();
    }
    if (!dependencies.isWorkspaceTrusted()) {
      add("workspace.trust", "Workspace trust", "blocked", "Trust is required before TODO orchestration", "workspace.trust");
      return result();
    }
    let root: string;
    try {
      root = options.workspaceRoot ?? workspaceRoot();
    } catch (error) {
      add("workspace.root", "Workspace", "blocked", message(error), "workspace.open");
      return result();
    }
    resolvedRoot = root;
    add("workspace", "Workspace", "ready", root);

    try {
      await assertNoRecoverableRun();
      add("todo.run", "Existing run", "ready", "No recoverable TODO run");
    } catch (error) {
      add("todo.run", "Existing run", "blocked", message(error), "doctor.run");
    }

    try {
      await worktrees.preflightRun(root, [], options.sealedInputPaths ?? []);
      add(
        "todo.git",
        "Git baseline",
        "ready",
        (options.sealedInputPaths ?? []).length > 0
          ? `Git repository is clean apart from ${String((options.sealedInputPaths ?? []).length)} sealed input path${(options.sealedInputPaths ?? []).length === 1 ? "" : "s"}`
          : "Git repository is clean",
      );
    } catch (error) {
      add("todo.git", "Git baseline", "blocked", message(error), "doctor.run");
    }

    const todoName = configuration().get<string>("todoFile", "TODO.md");
    let taskPipelineIds: string[] = [];
    try {
      const canonicalRoot = await canonicalizePath(root);
      const todoPath = await canonicalizePath(path.resolve(root, todoName));
      const todoRelativeToWorkspace = path.relative(canonicalRoot, todoPath);
      if (
        !todoRelativeToWorkspace ||
        todoRelativeToWorkspace.startsWith("..") ||
        path.isAbsolute(todoRelativeToWorkspace)
      ) {
        throw new Error("The configured TODO file must be inside the workspace folder");
      }
      const source = await readFile(todoPath, "utf8");
      const parsed = parseTodoDocument(todoPath, source, {
        pipelineId: defaultTaskPipelineId(options.mode),
        retries: configuration().get<number>("todoRetries", 1),
        requirePaths: true,
        requireControllerVerification: true,
      });
      if (parsed.tasks.length === 0) {
        throw new Error(`No checkbox tasks were found in ${todoName}`);
      }
      const incomplete = parsed.tasks.filter((task) => !task.completed);
      if (configuration().get<boolean>("todoRequireChecks", true)) {
        const uncheckedWithoutChecks = incomplete.filter((task) => !task.checksDeclared);
        if (uncheckedWithoutChecks.length > 0) {
          throw new Error(
            `Every incomplete TODO task must declare Verify or Verify: none. Missing: ${uncheckedWithoutChecks.map((task) => task.id).join(", ")}`,
          );
        }
      }
      taskPipelineIds = Array.from(new Set(incomplete.map((task) => task.pipelineId)));
      const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));
      const maxConcurrency = Math.max(1, configuration().get<number>("todoMaxConcurrency", 2));
      contract = {
        workspaceRoot: root,
        todoFile: todoName,
        taskIds: incomplete.map((task) => task.id),
        taskPipelineIds,
        masterPipelineId,
        verification: unique(incomplete.flatMap((task) => task.checks)),
        finalVerification: unique(incomplete.flatMap((task) => task.finalChecks ?? [])),
        verificationResources: unique(incomplete.flatMap((task) => [
          ...(task.checkResources ?? []),
          ...(task.finalCheckResources ?? []),
        ])),
        writablePaths: unique(incomplete.flatMap((task) => task.paths)),
        maxConcurrency,
        retries: configuration().get<number>("todoRetries", 1),
        commitPolicy: "never",
        isolation: [
          "Each task runs in its own Git worktree; results merge through a separate integration worktree.",
          "One exception: node_modules, .venv, venv and vendor are shared with your checkout rather than copied, so the checks can run.",
          "A command that writes through one of those directories writes into your repository, and that write is not in this run's patch, not in what Apply installs, and not undone by abandoning the run",
        ].join(" "),
        humanDecisions: [
          "None while the run is healthy; Master deviations and failures stop the run",
        ],
        completion: [
          `Every incomplete task in ${todoName} reaches done`,
          ...(unique(incomplete.flatMap((task) => task.checks)).length > 0
            ? [`Task verification passes: ${unique(incomplete.flatMap((task) => task.checks)).join(", ")}`]
            : []),
          ...(unique(incomplete.flatMap((task) => task.finalChecks ?? [])).length > 0
            ? [`Final verification passes: ${unique(incomplete.flatMap((task) => task.finalChecks ?? [])).join(", ")}`]
            : []),
          "The integration worktree holds every accepted task result",
        ],
      };
      add(
        "todo.tasks",
        todoName,
        "ready",
        `${String(incomplete.length)} runnable task${incomplete.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      add("todo.tasks", todoName, "blocked", message(error), "doctor.run");
    }

    const declaredVerifierCommands = Array.from(new Set([
      ...(contract?.verification ?? []),
      ...(contract?.finalVerification ?? []),
    ].filter((command) => isRepositoryVerifierCommand(command))));
    if (declaredVerifierCommands.length > 0) {
      const load = await loadVerifierRegistry(root);
      if (!load.present) {
        add(
          "todo.verifiers",
          "Repository verifiers",
          "blocked",
          `${VERIFIER_REGISTRY_PATH} does not exist, but tasks declare ${declaredVerifierCommands.join(", ")}`,
          "doctor.run",
        );
      } else if (load.errors.length > 0) {
        add("todo.verifiers", "Repository verifiers", "blocked", load.errors.join("; "), "doctor.run");
      } else {
        const missing = declaredVerifierCommands.filter(
          (command) => findVerifier(load.registry, command) === undefined,
        );
        if (missing.length > 0) {
          add(
            "todo.verifiers",
            "Repository verifiers",
            "blocked",
            `${VERIFIER_REGISTRY_PATH} declares no descriptor for ${missing.join(", ")}`,
            "doctor.run",
          );
        } else {
          add(
            "todo.verifiers",
            "Repository verifiers",
            "ready",
            declaredVerifierCommands.map((command) => {
              const descriptor = findVerifier(load.registry, command);
              return `${command} runs ${descriptor?.executable ?? ""} ${(descriptor?.args ?? []).join(" ")}`.trim();
            }).join("; "),
          );
        }
      }
    }

    for (const pipelineId of [masterPipelineId, ...taskPipelineIds]) {
      try {
        await manager.resolvePipelineSnapshotInScope(path.resolve(root), pipelineId, {
          requireCurrentCatalog: true,
          unattended: true,
          rejectChecklist: true,
        });
        add(`todo.pipeline.${pipelineId}`, pipelineId, "ready", "Unattended pipeline is available");
      } catch (error) {
        add(`todo.pipeline.${pipelineId}`, pipelineId, "needsSetup", message(error), "pipeline.chooseSupported");
      }
    }
    return result();
  };

  const inspectImproveReadiness = async (
    options: { sealedInputPaths?: string[] } = {},
  ): Promise<ImproveReadiness> => {
    const base = await inspectStartReadiness({ ...options, mode: "selfImprovement" });
    const ids = selfImprovementPipelineIds();
    const bootstrapPipelineIds = [ids.task, ids.discovery, ids.convergence, ids.review, ids.revision];
    // EX-G6-08. The readiness above already resolved the repository; using its answer is what
    // keeps every later question — which verifiers, which dialog, which approval — about the
    // same one.
    const root = base.workspaceRoot;
    const executability = root === undefined
      ? { executable: false, diagnostic: "No workspace folder is open" }
      : await todoExecutability(root);
    const findings = base.findings.filter((finding) => finding.id !== "todo.tasks");
    if (executability.executable) {
      findings.push({
        id: "improve.todo",
        label: "Executable TODO",
        status: "ready",
        detail: "The configured TODO parses; Improve runs it unchanged and skips discovery",
      });
    } else {
      findings.push({
        id: "improve.todo",
        label: "Executable TODO",
        status: "ready",
        detail: `No executable TODO, so Improve starts independent discovery first: ${executability.diagnostic ?? "unknown"}`,
      });
    }
    if (root !== undefined) {
      for (const pipelineId of bootstrapPipelineIds) {
        if (base.findings.some((finding) => finding.id === `todo.pipeline.${pipelineId}`)) continue;
        try {
          await manager.resolvePipelineSnapshotInScope(path.resolve(root), pipelineId, {
            requireCurrentCatalog: true,
            unattended: true,
            rejectChecklist: true,
          });
          findings.push({
            id: `todo.pipeline.${pipelineId}`,
            label: pipelineId,
            status: "ready",
            detail: "Unattended pipeline is available",
          });
        } catch (error) {
          findings.push({
            id: `todo.pipeline.${pipelineId}`,
            label: pipelineId,
            status: "needsSetup",
            detail: error instanceof Error ? error.message : String(error),
            remediationId: "pipeline.chooseSupported",
          });
        }
      }
    }
    return {
      ...base,
      findings,
      status: readinessStatus(findings),
      taskPipelinesWithOwnSteps: (base.contract?.taskPipelineIds ?? [])
        .filter((pipelineId) => pipelineId !== ids.task),
      todoExecutable: executability.executable,
      ...(executability.diagnostic === undefined ? {} : { todoDiagnostic: executability.diagnostic }),
      repositoryVerifiers: repositoryVerifierAuthorityFor("selfImprovement", root),
      bootstrapPipelineIds,
    };
  };

  const preflightChecklist = async (request: {
    workspaceRoot: string;
    allowedDirtyPaths?: string[];
  }): Promise<void> => {
    if (disposed) {
      throw new Error("TODO orchestrator is disposed");
    }
    if (!dependencies.isWorkspaceTrusted()) {
      throw new Error("Trust the workspace before executing a checklist");
    }
    await assertSameRepository(workspaceRoot(), request.workspaceRoot);
    await worktrees.preflightRun(
      request.workspaceRoot,
      request.allowedDirtyPaths ?? [],
    );
  };

  const startChecklist = async (
    request: GeneratedChecklistRun,
  ): Promise<OrchestrationLedger> => {
    if (disposed) {
      throw new Error("TODO orchestrator is disposed");
    }
    if (!dependencies.isWorkspaceTrusted()) {
      throw new Error("Trust the workspace before executing a checklist");
    }
    claimStartup();
    let began = false;
    let master: Awaited<ReturnType<typeof createMasterConversation>> | undefined;
    let prepared: RunWorktree | undefined;
    let persisted = false;
    let activePointerWritten = false;
    let retainUnsafeOwner = false;
    try {
      assertStartupNotCancelled();
      await acquireOrchestrationOwner(request.workspaceRoot, "start checklist orchestration");
      assertStartupNotCancelled();
      await assertNoRecoverableRun();
      const parsedTaskPipelineSnapshot = parsePipelineSnapshot(
        request.pipelineSnapshot,
      );
      if (
        !parsedTaskPipelineSnapshot ||
        !pipelineSnapshotsEqual(parsedTaskPipelineSnapshot, request.pipelineSnapshot) ||
        parsedTaskPipelineSnapshot.definition.id !== request.pipelineId ||
        parsedTaskPipelineSnapshot.dependencies ||
        parsedTaskPipelineSnapshot.bundleHash
      ) {
        throw new Error("Checklist task pipeline snapshot is invalid");
      }
      const selectedIds = new Set(request.selectedIssueIds);
      const unknown = [...selectedIds].filter(
        (id) => !request.issues.some((issue) => issue.id === id),
      );
      if (unknown.length > 0) {
        throw new Error(`Checklist selected unknown task ids: ${unknown.join(", ")}`);
      }
      const selected = request.issues.filter((issue) => selectedIds.has(issue.id));
      if (request.checks.length === 0 && !request.allowNoChecks) {
        throw new Error("Checklist execution requires user-authored checks or explicit allowNoChecks");
      }
      const generatedScope = validateGeneratedTasks(selected, {
        authority: "user",
        allowedPaths: request.allowedPaths,
      });
      await assertSameRepository(workspaceRoot(), request.workspaceRoot);
      const readableTitle = `Execute · ${request.title}`;
      master = await createMasterConversation({
        title: readableTitle,
        parentConversationId: request.parentConversationId,
      });
      assertStartupNotCancelled();
      prepared = await worktrees.prepareRun(
        request.workspaceRoot,
        master.runId,
        request.allowedDirtyPaths ?? [],
        "never",
        request.sealedInputPaths ?? [],
      );
      const now = new Date().toISOString();
      const retries = Math.max(0, Math.min(10, Math.trunc(request.retries)));
      const current: OrchestrationLedger = {
        version: 1,
        runId: master.runId,
        title: formatRunTitle(master.runId, readableTitle),
        status: "preparing",
        workspaceRoot: prepared.repositoryRoot,
        ownerWorkspaceRoot: path.resolve(workspaceRoot()),
        sourceKind: "generatedChecklist",
        parentRunRef: request.parentRunRef,
        ...(request.parentConversationId === undefined
          ? {}
          : { parentConversationId: request.parentConversationId }),
        ...(request.userNote.trim() ? { userNote: request.userNote.trim() } : {}),
        generatedAllowedPaths: generatedScope.allowedPaths,
        integrationBranch: prepared.integrationBranch,
        integrationWorktree: prepared.integrationWorktree,
        baselineCommit: prepared.baselineCommit,
        ...(prepared.inputTree ? { inputTree: prepared.inputTree } : {}),
        ...(prepared.sealedInputPaths ? { sealedInputPaths: [...prepared.sealedInputPaths] } : {}),
        ...(prepared.integrationTree ? { integrationTree: prepared.integrationTree } : {}),
        commitMode: prepared.commitMode,
        createdAt: now,
        updatedAt: now,
        maxConcurrency: Math.max(1, Math.min(20, Math.trunc(request.maxConcurrency))),
        masterConversationId: master.conversationId,
        masterPipelineId: master.pipelineId,
        masterPipelineSnapshot: master.pipelineSnapshot,
        masterChecks: [],
        tasks: Object.fromEntries(selected.map((issue, index) => {
          const paths = generatedScope.issuePaths.get(issue.id) as string[];
          return [
            issue.id,
            {
              spec: {
                id: issue.id,
                title: issue.title,
                description: issue.details,
                completed: false,
                line: index + 1,
                explicitId: true,
                dependsOn: [...issue.dependencies],
                pipelineId: request.pipelineId,
                pipelineSnapshot: structuredClone(parsedTaskPipelineSnapshot),
                paths,
                checks: [],
                checksDeclared: true,
                checkResources: [],
                finalChecks: [],
                finalChecksDeclared: true,
                finalCheckResources: [],
                priority: selected.length - index,
                retries,
              },
              status: "pending",
              attempts: 0,
            } satisfies OrchestrationTaskState,
          ];
        })),
        finalChecks: [],
        finalCheckCommands: Array.from(new Set(request.checks)),
        finalCheckResources: Array.from(new Set(request.checkResources ?? [])),
      };
      assertStartupNotCancelled();
      await store.save(current);
      persisted = true;
      assertStartupNotCancelled();
      await store.setActiveRun(current.runId);
      activePointerWritten = true;
      assertStartupNotCancelled();
      began = true;
      return begin(current);
    } catch (error) {
      try {
        await cleanupNewRun({
          ...(master === undefined ? {} : { master }),
          ...(prepared === undefined ? {} : { prepared }),
          persisted,
          activePointerWritten,
        });
      } catch (cleanupError) {
        retainUnsafeOwner = true;
        await failUnsafeStartupRollback(
          error,
          cleanupError,
          "Checklist startup and rollback both failed",
        );
      }
      throw error;
    } finally {
      releaseStartup();
      if (!began && !retainUnsafeOwner) {
        await releaseOrchestrationOwner();
      }
    }
  };

  const resumeIfAvailable = async (): Promise<OrchestrationLedger | undefined> => {
    if (disposed) {
      throw new Error("TODO orchestrator is disposed");
    }
    if (!dependencies.isWorkspaceTrusted()) {
      throw new Error("Trust the workspace before running TODO orchestration");
    }
    claimStartup();
    let began = false;
    let createdMasterConversationId: string | undefined;
    try {
      const currentWorkspaceRoot = workspaceRoot();
      assertStartupNotCancelled();
      await acquireOrchestrationOwner(currentWorkspaceRoot, "resume TODO orchestration");
      assertStartupNotCancelled();
      await initialization;
      const runId = await store.getActiveRun();
      if (!runId) {
        return undefined;
      }
      const current = await store.load(runId);
      current.commitMode = ledgerCommitMode(current);
      const currentOwnerRoot = path.resolve(workspaceRoot());
      // Re-derived from the live approval for this run's own repository, never trusted from the
      // persisted ledger. EX-G6-08: the approval names a repository, so this has to as well.
      current.repositoryVerifierAuthority = repositoryVerifierAuthorityFor(
        current.mode,
        current.ownerWorkspaceRoot ?? currentOwnerRoot,
      );
      if (current.ownerWorkspaceRoot) {
        if (path.resolve(current.ownerWorkspaceRoot) !== currentOwnerRoot) {
          throw new Error("The persisted TODO run belongs to a different workspace");
        }
      } else {
        const relativeOwner = path.relative(
          path.resolve(current.workspaceRoot),
          currentOwnerRoot,
        );
        if (
          relativeOwner.startsWith("..") ||
          path.isAbsolute(relativeOwner)
        ) {
          throw new Error(
            "The legacy TODO run cannot be safely bound to this workspace",
          );
        }
      }
      if (current.status === "completed" || current.status === "abandoned") {
        await store.setActiveRun(undefined);
        return undefined;
      }
      if (!current.masterPipelineSnapshot) {
        throw new Error(
          "This TODO run predates immutable Master pipeline snapshots. Abandon it and start a new run.",
        );
      }
      const missingTaskSnapshots = Object.values(current.tasks)
        .filter((task) => task.status !== "done" && !task.spec.pipelineSnapshot)
        .map((task) => task.spec.id);
      if (missingTaskSnapshots.length > 0) {
        throw new Error(
          `This TODO run predates immutable task-pipeline snapshots for: ${missingTaskSnapshots.join(", ")}. Abandon it and start a new run.`,
        );
      }
      if (current.status === "abandoning") {
        throw new Error("The TODO run is being abandoned. Run Abandon TODO Run again to finish cleanup.");
      }
      // Resuming would restart the question as work. The decision is the human's, and answering
      // it changes what the plan should be, so the run is abandoned and Improve is run again.
      if ((current.humanDecisionBlockers ?? []).length > 0) {
        throw new Error(
          `This run stopped on a decision Bachata does not own, so it cannot be resumed: ${(current.humanDecisionBlockers ?? []).join("; ")}. Answer it, abandon this run, and run Bachata: Improve This Project again.`,
        );
      }
      await assertSameRepository(currentOwnerRoot, current.workspaceRoot);
      // A rollback marker names an integration this run started and never confirmed. Integration
      // is serialized and a task clears its own marker in the same step that records it done, so
      // a `done` task still holding one, or two tasks holding one at once, is a ledger no
      // recovery can read: resetting would discard work the ledger, the UI and the final record
      // all report as accepted. Both shapes refuse before anything is restored or reset.
      const pendingRollbacks = Object.values(current.tasks).flatMap((task) =>
        task.integrationRollbackCommit === undefined
          ? []
          : [{ task, commit: task.integrationRollbackCommit }],
      );
      const acceptedRollbacks = pendingRollbacks.filter((entry) => entry.task.status === "done");
      if (acceptedRollbacks.length > 0) {
        throw new Error(
          `This TODO run records ${acceptedRollbacks.map((entry) => entry.task.spec.id).join(", ")} as done while still naming an integration rollback commit, so recovering it could discard accepted work. Abandon this run and start a new one.`,
        );
      }
      if (pendingRollbacks.length > 1) {
        throw new Error(
          `This TODO run names an integration rollback commit for more than one task (${pendingRollbacks.map((entry) => entry.task.spec.id).join(", ")}), so the point to recover to is ambiguous. Abandon this run and start a new one.`,
        );
      }
      // A marker on a blocked task outlives the task that wrote it: the run carries on with its
      // siblings, and one of them can integrate and be accepted after it. Resetting to the older
      // point would then discard that accepted work just as silently as a marker on a `done`
      // task would. The marker records the count of acceptances it was written after, so the two
      // cases separate: equal counts mean everything accepted is already contained in the
      // marker's commit, and a higher count means it is not. A ledger that recorded no count
      // cannot answer, so it is resumable only while there is nothing accepted to lose.
      const [pendingRollback] = pendingRollbacks;
      const acceptedTaskIds = Object.values(current.tasks)
        .filter((task) => task.status === "done")
        .map((task) => task.spec.id);
      if (pendingRollback && acceptedTaskIds.length > 0) {
        const accepted = recordedCount(current.acceptedIntegrations);
        const sequence = recordedCount(pendingRollback.task.integrationRollbackSequence);
        const ordered = accepted !== undefined && sequence !== undefined && accepted <= sequence;
        if (!ordered) {
          throw new Error(
            `This TODO run names an integration rollback commit for ${pendingRollback.task.spec.id} and records ${acceptedTaskIds.join(", ")} as accepted, and the ledger cannot show that commit still contains that work, so recovering to it could discard it. Abandon this run and start a new one.`,
          );
        }
      }
      const run = runWorktree(current);
      assertStartupNotCancelled();
      await worktrees.restoreRun(run);
      assertStartupNotCancelled();
      for (const { task, commit } of pendingRollbacks) {
        assertStartupNotCancelled();
        await worktrees.resetIntegration(run, commit);
        assertStartupNotCancelled();
        if (!shouldCreateManagedCommit(current.commitMode)) {
          current.integrationTree = commit;
        }
        delete task.integrationRollbackCommit;
        delete task.integrationRollbackSequence;
        task.lastError = "Recovered the integration branch to its last confirmed commit.";
      }
      const completedTodoTaskIds = new Set<string>();
      // Whichever file the controller owns for this run is the record of what is already done,
      // so resuming never re-executes accepted work.
      const generatedChecklist = controllerTodoPath(current);
      const recoveryTodo = current.sourceKind === "todoFile"
        ? await relativeTodoPath(current.workspaceRoot, current.todoPath as string)
        : generatedChecklist;
      if (recoveryTodo !== undefined) {
        const absolute = path.join(current.integrationWorktree, ...recoveryTodo.split("/"));
        const firstTask = Object.values(current.tasks)[0];
        const parsed = parseTodoDocument(absolute, await readFile(absolute, "utf8"), {
          pipelineId: firstTask?.spec.pipelineId ?? configuration().get<string>("todoPipeline", "todo-implementation"),
          retries: firstTask?.spec.retries ?? configuration().get<number>("todoRetries", 1),
          requirePaths: true,
          requireControllerVerification: true,
        });
        parsed.tasks
          .filter((task) => task.completed)
          .forEach((task) => completedTodoTaskIds.add(task.id));
      }
      assertStartupNotCancelled();
      if (!current.masterConversationId) {
        const master = await createMasterConversation({
          title: current.sourceKind === "todoFile"
            ? `TODO · ${path.basename(current.workspaceRoot)}`
            : "Execute checklist",
          pipelineSnapshot: current.masterPipelineSnapshot,
          ...(current.parentConversationId
            ? { parentConversationId: current.parentConversationId }
            : {}),
        });
        current.masterConversationId = master.conversationId;
        current.masterPipelineId = master.pipelineId;
        createdMasterConversationId = master.conversationId;
        assertStartupNotCancelled();
      }
      current.masterChecks ??= [];
      for (const task of Object.values(current.tasks)) {
        const recoveredCompletion =
          recoveryTodo !== undefined &&
          task.status !== "done" &&
          completedTodoTaskIds.has(task.spec.id);
        const completed = task.status === "done" || recoveredCompletion;
        if (task.conversationId) {
          releaseRoom(task);
          if (!completed) {
            delete task.conversationId;
          }
        }
        const previous = taskWorktree(task, current.commitMode);
        if (previous && task.implementationComplete && !completed) {
          task.status = "pending";
          delete task.completedAt;
          task.lastError = "Implementation is complete; deterministic verification will resume.";
          delete task.result;
          continue;
        }
        if (previous) {
          assertStartupNotCancelled();
          await worktrees.removeTask(run, previous);
          assertStartupNotCancelled();
        }
        delete task.worktreePath;
        delete task.branch;
        delete task.baseCommit;
        delete task.baseTree;
        task.implementationComplete = false;
        if (completed) {
          task.spec.completed = current.sourceKind === "todoFile" ? true : task.spec.completed;
          task.status = "done";
          task.completedAt ??= new Date().toISOString();
          delete task.lastError;
          if (recoveredCompletion) {
            task.result = {
              status: "done",
              summary: "Recovered completed work from the integration TODO state.",
              changedFiles: task.result?.status === "done" ? task.result.changedFiles : [],
              checks: task.result?.status === "done" ? task.result.checks : [],
              blockers: [],
              ...(task.result?.pipelineStatus ? { pipelineStatus: task.result.pipelineStatus } : {}),
            };
          }
          continue;
        }
        delete task.commit;
        resetIncompleteTask(task, "Run resumed from persisted state");
        if (task.status === "pending") {
          delete task.result;
        }
      }
      current.status = "preparing";
      delete current.error;
      assertStartupNotCancelled();
      await store.save(current);
      assertStartupNotCancelled();
      await store.setActiveRun(current.runId);
      assertStartupNotCancelled();
      began = true;
      return begin(current);
    } catch (error) {
      if (createdMasterConversationId) {
        await manager.closeConversation(createdMasterConversationId).catch(() => undefined);
      }
      throw error;
    } finally {
      releaseStartup();
      if (!began) {
        await releaseOrchestrationOwner();
      }
    }
  };

  const resume = async (): Promise<OrchestrationLedger> => {
    const current = await resumeIfAvailable();
    if (!current) {
      throw new Error("There is no stopped or failed TODO run to resume");
    }
    return current;
  };

  const stop = async (): Promise<void> => {
    const current = ledger;
    const currentOperation = operation;
    maintenanceController?.abort();
    startupController?.abort();
    if (!currentOperation || !current) {
      controller?.abort();
      await drainPendingWork();
      return;
    }
    current.status = "stopping";
    current.stopRequestedAt = new Date().toISOString();
    controller?.abort();
    if (workspaceLeaseValid()) {
      await save(current);
    }
    const timeoutMs = Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "todoStopTimeoutMs", 30_000));
    await bounded(
      Promise.allSettled(
        Array.from(activeConversations, (conversationId) =>
          manager.interruptConversation(conversationId),
        ),
      ),
      timeoutMs,
      "TODO provider interruption",
    ).catch((error) => {
      output.appendLine(error instanceof Error ? error.message : String(error));
    });
    try {
      await bounded(currentOperation.catch(() => undefined), timeoutMs, "TODO orchestration stop");
    } catch (error) {
      const reason = `TODO stop cleanup was not confirmed: ${error instanceof Error ? error.message : String(error)}`;
      await Promise.allSettled(Array.from(activeCheckLeases, (lease) => lease.quarantine(reason)));
      await quarantineOrchestrationOwner(reason);
      current.status = "stopped";
      current.error = reason;
      if (workspaceLeaseValid()) {
        await save(current);
      }
    }
    await drainPendingWork();
  };

  const abandon = async (): Promise<void> => {
    await initialization;
    if (operation) {
      await stop();
    }
    if (startupClaimed) {
      throw new Error("TODO orchestration is still preparing");
    }
    await acquireOrchestrationOwner(workspaceRoot(), "abandon TODO orchestration");
    try {
      let current = ledger;
      if (!current) {
        try {
          const activeRunId = await store.getActiveRun();
          current = activeRunId ? await store.load(activeRunId) : undefined;
        } catch (error) {
          throw new Error(
            `Cannot abandon invalid orchestration recovery state without verified Git ownership: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      if (!current) {
        return;
      }
      assertCurrentWorkspaceOwns(current);
      const pending = structuredClone(current);
      pending.status = "abandoning";
      pending.error = "Abandoning TODO run";
      await store.save(pending);
      ledger = pending;
      emit();

      const conversationIds = new Set(
        Object.values(pending.tasks)
          .map((task) => task.conversationId)
          .filter((value): value is string => Boolean(value)),
      );
      if (pending.masterConversationId) {
        conversationIds.add(pending.masterConversationId);
      }
      conversationIds.forEach((conversationId) => {
        activeConversations.delete(conversationId);
      });

      await worktrees.abandonRun(runWorktree(pending));
      const finalized = abandonedLedger(pending);
      await store.save(finalized);
      await store.setActiveRun(undefined);
      retainedLedgers.delete(finalized.runId);
      if (ledger?.runId === finalized.runId) {
        ledger = undefined;
      }
      emit();
    } finally {
      await releaseOrchestrationOwner();
    }
  };
  const retainedRun = async (runId: string): Promise<OrchestrationLedger> => {
    assertWorkspaceLease();
    if (disposed) {
      throw new Error("TODO orchestrator is disposed");
    }
    await initialization;
    if (operation || startupClaimed) {
      throw new Error("Wait for the active TODO operation to finish before cleaning retained Git resources");
    }
    const current = retainedLedgers.get(runId) ?? await store.load(runId);
    if (current.status !== "completed" && current.status !== "cleanupPending") {
      throw new Error("Only completed TODO runs can be cleaned up from retained resources");
    }
    assertCurrentWorkspaceOwns(current);
    return current;
  };

  const cleanupRetained = async (runId: string): Promise<void> => {
    const current = await retainedRun(runId);
    await acquireOrchestrationOwner(current.workspaceRoot, `clean retained TODO run ${runId}`);
    try {
      const pending = structuredClone(current);
      pending.status = "cleanupPending";
      pending.error = "Cleaning retained TODO Git resources";
      await store.save(pending);
      retainedLedgers.set(runId, pending);
      emit();
      await worktrees.abandonRun(runWorktree(pending));
      const activeRunId = await store.getActiveRun();
      if (activeRunId === runId) {
        await store.setActiveRun(undefined);
      }
      await store.remove(runId);
      retainedLedgers.delete(runId);
      if (ledger?.runId === runId) {
        ledger = undefined;
      }
      emit();
    } finally {
      await releaseOrchestrationOwner();
    }
  };

  const resolveRetainedWorktree = async (runId: string): Promise<string> =>
    (await retainedRun(runId)).integrationWorktree;

  const retainedCheckPlan = (
    current: OrchestrationLedger,
  ): { commands: string[]; resources: string[] } => {
    const executed = Object.values(current.tasks).filter((task) => !task.spec.completed);
    return {
      commands: Array.from(new Set([
        ...executed.flatMap((task) => task.spec.checks),
        ...(current.finalCheckCommands ?? executed.flatMap((task) => task.spec.finalChecks ?? [])),
      ])),
      resources: Array.from(new Set([
        ...executed.flatMap((task) => task.spec.checkResources ?? []),
        ...(current.finalCheckResources ?? executed.flatMap((task) => task.spec.finalCheckResources ?? [])),
      ])),
    };
  };

  /** P3. The candidate Apply would carry, which is the tree verification exports too. */
  const retainedFingerprint = (
    current: OrchestrationLedger,
    selection?: PatchSelection | undefined,
  ): string =>
    retainedCandidateFingerprint(
      { candidate: current.integrationTree ?? current.integrationBranch },
      selection,
    );

  /**
   * EX-A5-R01. The commit the receiving branch is on, or a refusal.
   *
   * Reading it can fail on a repository being rewritten underneath us. A HEAD nobody could read
   * is not evidence of anything, and inventing a value for it — even one deliberately unequal to
   * every other value — writes an evidence record that names a commit that never existed. The
   * read either answers or refuses.
   */
  const readTargetHead = async (current: OrchestrationLedger): Promise<string> => {
    try {
      return await worktrees.targetHead(runWorktree(current));
    } catch (error) {
      throw new Error(
        `The receiving branch's HEAD could not be read, so this run's verification cannot be bound to it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  /**
   * EX-A5-R01 residue. Why this run's checks may not be composed at all, or nothing.
   *
   * The validation tree is `run.baselineCommit` plus the run's candidate: `prepareExportValidation`
   * fetches exactly that commit and checks it out detached before applying anything. So evidence
   * produced here is evidence about that composition and no other, and a receiving branch that has
   * moved cannot be verified by re-running it — the result would be the old composition wearing a
   * label naming a commit it never saw. Recomposing the candidate onto the moved branch is a
   * feature that does not exist, so the honest answer is a refusal before anything is composed.
   */
  const targetDriftRefusal = (
    current: OrchestrationLedger,
    target: string,
  ): string | undefined =>
    target === current.baselineCommit
      ? undefined
      : `The receiving branch is on ${target.slice(0, 12)}, but this run's checks are composed on the commit it started from, ${current.baselineCommit.slice(0, 12)}. Re-running them would prove nothing about the branch as it stands. Rebase this work onto the branch and start a new run.`;

  /**
   * EX-A5-R01. Prove the receiving branch is still where it was when these checks were composed.
   *
   * Checks are evidence about one composition: the candidate on top of one exact receiving HEAD.
   * A branch that moved before, during or after them leaves that composition unverified, and
   * recording the HEAD as it is *now* against checks that ran against the old one labels somebody
   * else's commit with this run's verification. The reading is taken again after the checks and
   * again immediately before the evidence is written, and all of them have to agree.
   */
  const assertTargetUnmoved = async (
    current: OrchestrationLedger,
    target: string,
    when: string,
  ): Promise<void> => {
    const now = await readTargetHead(current);
    if (now !== target) {
      throw new Error(
        `The receiving branch moved from ${target.slice(0, 12)} to ${now.slice(0, 12)} ${when}, so these checks prove nothing about the branch as it stands. Rebase if you need to, then re-run the retained checks and apply once they pass.`,
      );
    }
  };

  const recordRetainedEvidence = async (
    current: OrchestrationLedger,
    fingerprint: string,
    checks: readonly VerificationCheckResult[],
    // EX-A5-R01. The HEAD read before the checks were composed. It is what the evidence is
    // labelled with, and it is re-read here so nothing is written about a branch that has moved
    // between the last check finishing and this record being persisted.
    target: string,
  ): Promise<void> => {
    // EX-A5-R01. The window this second reading exists to close is everything between the check
    // that followed the run and this write, and it holds no other await. Nothing in production
    // supplies this hook; a test moves the branch from it to stand inside exactly that window.
    await dependencies.beforeOrchestrationOperation?.("retainedEvidence", { runId: current.runId });
    await assertTargetUnmoved(current, target, "before its verification was recorded");
    const stored = retainedLedgers.get(current.runId) ?? current;
    stored.retainedEvidence = withRetainedEvidence(stored.retainedEvidence, {
      fingerprint,
      checks: structuredClone([...checks]),
      target,
    });
    await store.save(stored);
    retainedLedgers.set(current.runId, stored);
    emit();
  };

  const verifyRetainedExport = async (
    runId: string,
    selection: PatchSelection | undefined,
    label: string,
  ): Promise<VerificationCheckResult[]> => {
    const current = await retainedRun(runId);
    const plan = retainedCheckPlan(current);
    if (plan.commands.length === 0) return [];
    // EX-A5-R01 residue. The receiving HEAD is read before anything is composed, acquired or run,
    // and a branch that has already moved is refused here rather than checked: the tree these
    // commands would run in is composed on the run's own baseline, so a recheck cannot adopt a
    // HEAD the run was never composed against. Refusing before ownership is acquired leaves the
    // retained worktree and the workspace exactly as they were.
    const target = await readTargetHead(current);
    const drift = targetDriftRefusal(current, target);
    if (drift) throw new Error(drift);
    await acquireOrchestrationOwner(current.workspaceRoot, `${label} retained TODO run ${runId}`);
    const maintenance = new AbortController();
    maintenanceController = maintenance;
    try {
      const verification = await runIsolatedChecks(
        current,
        current.integrationWorktree,
        `${label}-${runId}`,
        plan.commands,
        plan.resources,
        undefined,
        {
          exportSource: true,
          ...(selection === undefined ? {} : { selection }),
          abort: () => maintenance,
        },
      );
      if (verification.sourceChanged) {
        throw new Error(
          "The retained run worktree changed while its checks were running, so this verification proves nothing",
        );
      }
      // P3. The evidence is bound to the candidate it was produced against — and, for a
      // selection, to that selection — so a later change to the retained worktree invalidates it
      // rather than carrying it forward to work nobody checked.
      await assertTargetUnmoved(current, target, "while its checks were running");
      const fingerprint = retainedFingerprint(current, selection);
      const bound = verification.checks.map((check) => ({ ...check, candidateTree: fingerprint }));
      await recordRetainedEvidence(current, fingerprint, bound, target);
      return bound;
    } finally {
      if (maintenanceController === maintenance) {
        maintenanceController = undefined;
      }
      await releaseOrchestrationOwner();
    }
  };

  const rerunRetainedChecks = async (runId: string): Promise<VerificationCheckResult[]> =>
    verifyRetainedExport(runId, undefined, "recheck");

  const verifyRetainedSelection = async (
    runId: string,
    selection: PatchSelection,
  ): Promise<VerificationCheckResult[]> =>
    verifyRetainedExport(runId, selection, "verify-selection");

  const retainedRunPatch = async (runId: string, selection?: PatchSelection): Promise<string> =>
    worktrees.runPatch(runWorktree(await retainedRun(runId)), selection);

  const retainedRunPatchFiles = async (runId: string): Promise<PatchFileSummary[]> =>
    worktrees.runPatchFiles(runWorktree(await retainedRun(runId)));

  const applyRetained = async (runId: string, selection?: PatchSelection): Promise<ApplyRunResult> => {
    const current = await retainedRun(runId);
    // P3. Apply is the moment the work reaches the workspace, so it is the moment the run's own
    // declared checks have to have passed against the exact candidate being applied. The refusal
    // happens before ownership is acquired and before anything is written, so a blocked Apply
    // leaves the retained worktree exactly as it was.
    const refusal = retainedApplyRefusal({
      required: retainedCheckPlan(current).commands,
      evidence: current.retainedEvidence,
      fingerprint: retainedFingerprint(current, selection),
      selective: selection !== undefined,
      // EX-A5-R01. Read again here, at the moment the work would reach the workspace. An
      // unreadable HEAD raises rather than resolving to a value nothing can equal.
      target: await readTargetHead(current),
    });
    if (refusal) {
      throw new Error(refusal);
    }
    await acquireOrchestrationOwner(current.workspaceRoot, `apply retained TODO run ${runId}`);
    try {
      return await worktrees.applyRun(runWorktree(current), selection);
    } finally {
      await releaseOrchestrationOwner();
    }
  };

  const handleWorkspaceLeaseLost = (): void => {
    controller?.abort();
    activeConversations.forEach((conversationId) => {
      void manager.interruptConversation(conversationId).catch((error) => {
        output.appendLine(
          `Failed to interrupt TODO conversation after workspace ownership was lost: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  };
  dependencies.workspaceLease?.signal.addEventListener("abort", handleWorkspaceLeaseLost, { once: true });

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    dependencies.workspaceLease?.signal.removeEventListener("abort", handleWorkspaceLeaseLost);
    maintenanceController?.abort();
    startupController?.abort();
    await stop();
    const drained = await drainPendingWork();
    if (drained) {
      await releaseOrchestrationOwner();
    } else {
      const reason = "TODO orchestration was disposed while startup or retained maintenance was still running";
      output.appendLine(reason);
      await quarantineOrchestrationOwner(reason);
    }
    listeners.clear();
  };

  return {
    start: (options) => trackWork(() => startFromTodo({ ...(options ?? {}), mode: "todo" })),
    improve: (options) => trackWork(() => improve(options ?? {})),
    inspectImproveReadiness: (options) => trackWork(() => inspectImproveReadiness(options ?? {})),
    dirtyRepositoryPaths: () => trackWork(() => worktrees.dirtyRepositoryPaths(workspaceRoot())),
    inspectStartReadiness: (options) => trackWork(() => inspectStartReadiness(options ?? {})),
    startChecklist: (request) => trackWork(() => startChecklist(request)),
    preflightChecklist: (request) => trackWork(() => preflightChecklist(request)),
    resume: () => trackWork(resume),
    resumeIfAvailable: () => trackWork(resumeIfAvailable),
    stop,
    abandon,
    cleanupRetained: (runId) => trackWork(() => cleanupRetained(runId)),
    resolveRetainedWorktree: (runId) => trackWork(() => resolveRetainedWorktree(runId)),
    retainedRunPatch: (runId, selection) => trackWork(() => retainedRunPatch(runId, selection)),
    retainedRunPatchFiles: (runId) => trackWork(() => retainedRunPatchFiles(runId)),
    applyRetained: (runId, selection) => trackWork(() => applyRetained(runId, selection)),
    rerunRetainedChecks: (runId) => trackWork(() => rerunRetainedChecks(runId)),
    verifyRetainedSelection: (runId, selection) =>
      trackWork(() => verifyRetainedSelection(runId, selection)),
    getSnapshot: snapshot,
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose,
  };
};
