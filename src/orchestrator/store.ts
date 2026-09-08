import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";

import { isPathInsideRoot } from "../process/pathBoundary";

import { parsePipelineSnapshot } from "../pipeline/identity";
import { legacyStorageIdentity, taskStorageIdentity } from "./identity";
import {
  OrchestrationLedger,
  OrchestrationRunStatus,
  OrchestrationTaskState,
  OrchestrationTaskStatus,
  TodoTaskSpec,
  VerificationCheckResult,
} from "./types";

const atomicWrite = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const safeSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const pipelineIdPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const commitPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const integrationBranchPattern = /^bachata\/integration\/[A-Za-z0-9._-]+$/u;
const runStatuses = new Set<OrchestrationRunStatus>([
  "preparing",
  "running",
  "stopping",
  "stopped",
  "completed",
  "blocked",
  "failed",
  "abandoning",
  "cleanupPending",
  "abandoned",
]);
const taskStatuses = new Set<OrchestrationTaskStatus>([
  "pending",
  "ready",
  "running",
  "waitingForResources",
  "verifying",
  "integrating",
  "done",
  "blocked",
  "failed",
  "cancelled",
]);
const checkStatuses = new Set<VerificationCheckResult["status"]>([
  "passed",
  "failed",
  "timedOut",
  "cancelled",
]);
const masterDeviationKinds = new Set([
  "skippedTask",
  "wrongTask",
  "missingCompletion",
  "stalledTask",
  "retryPolicy",
  "todoState",
]);

const contained = (root: string, candidate: string): boolean =>
  isPathInsideRoot(root, candidate);

const requireString = (value: unknown, field: string, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid orchestration ledger field: ${field}`);
  }
  return value;
};

const requireInteger = (
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Invalid orchestration ledger field: ${field}`);
  }
  return value as number;
};

const requireStringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid orchestration ledger field: ${field}`);
  }
  return value as string[];
};

const validateRepositoryPath = (value: string, field: string): void => {
  const platformPath = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  const normalized = path.posix.normalize(platformPath);
  if (
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid orchestration ledger field: ${field}`);
  }
};

const normalizeRepositoryPath = (value: string): string => {
  const platformPath = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  return path.posix.normalize(platformPath).replace(/^\.\//u, "").replace(/\/$/u, "") || ".";
};

const pathWithinScope = (candidate: string, scope: string): boolean =>
  scope === "." || candidate === scope || candidate.startsWith(`${scope}/`);

const validateCheck = (value: unknown, field: string): void => {
  if (!isRecord(value)) {
    throw new Error(`Invalid orchestration ledger field: ${field}`);
  }
  requireString(value.command, `${field}.command`);
  if (typeof value.status !== "string" || !checkStatuses.has(value.status as VerificationCheckResult["status"])) {
    throw new Error(`Invalid orchestration ledger field: ${field}.status`);
  }
  if (value.exitCode !== undefined) {
    requireInteger(value.exitCode, `${field}.exitCode`, -2147483648, 2147483647);
  }
  if (value.workingDirectory !== undefined) requireString(value.workingDirectory, `${field}.workingDirectory`);
  if (value.candidateTree !== undefined) {
    const candidateTree = requireString(value.candidateTree, `${field}.candidateTree`);
    if (!commitPattern.test(candidateTree)) throw new Error(`Invalid orchestration ledger field: ${field}.candidateTree`);
  }
  if (value.outputReference !== undefined) requireString(value.outputReference, `${field}.outputReference`);
  requireString(value.stdout, `${field}.stdout`, true);
  requireString(value.stderr, `${field}.stderr`, true);
  requireString(value.startedAt, `${field}.startedAt`);
  requireString(value.completedAt, `${field}.completedAt`);
  if (value.cleanupConfirmed !== undefined && typeof value.cleanupConfirmed !== "boolean") {
    throw new Error(`Invalid orchestration ledger field: ${field}.cleanupConfirmed`);
  }
};

const validateTaskSpec = (value: unknown, field: string): TodoTaskSpec => {
  if (!isRecord(value)) {
    throw new Error(`Invalid orchestration ledger field: ${field}`);
  }
  const id = requireString(value.id, `${field}.id`);
  if (!taskIdPattern.test(id)) {
    throw new Error(`Invalid orchestration ledger field: ${field}.id`);
  }
  requireString(value.title, `${field}.title`);
  requireString(value.description, `${field}.description`, true);
  if (typeof value.completed !== "boolean" || typeof value.explicitId !== "boolean" || typeof value.checksDeclared !== "boolean") {
    throw new Error(`Invalid orchestration ledger field: ${field}`);
  }
  requireInteger(value.line, `${field}.line`, 1);
  const dependsOn = requireStringArray(value.dependsOn, `${field}.dependsOn`);
  dependsOn.forEach((dependency, index) => {
    if (!taskIdPattern.test(dependency)) {
      throw new Error(`Invalid orchestration ledger field: ${field}.dependsOn.${String(index)}`);
    }
  });
  const pipelineId = requireString(value.pipelineId, `${field}.pipelineId`);
  if (!pipelineIdPattern.test(pipelineId)) {
    throw new Error(`Invalid orchestration ledger field: ${field}.pipelineId`);
  }
  const pipelineSnapshot = value.pipelineSnapshot === undefined
    ? undefined
    : parsePipelineSnapshot(value.pipelineSnapshot);
  if (
    value.pipelineSnapshot !== undefined &&
    (!pipelineSnapshot ||
      pipelineSnapshot.definition.id !== pipelineId ||
      pipelineSnapshot.dependencies !== undefined ||
      pipelineSnapshot.bundleHash !== undefined)
  ) {
    throw new Error(`Invalid orchestration ledger field: ${field}.pipelineSnapshot`);
  }
  const paths = requireStringArray(value.paths, `${field}.paths`);
  paths.forEach((item, index) => validateRepositoryPath(item, `${field}.paths.${String(index)}`));
  requireStringArray(value.checks, `${field}.checks`).forEach((command, index) => {
    if (!command.trim()) {
      throw new Error(`Invalid orchestration ledger field: ${field}.checks.${String(index)}`);
    }
  });
  // Validated for its throw, not for its value: the record is returned by spreading
  // `value`, and every reader of these fields already supplies its own `?? []`.
  if (value.checkResources !== undefined) {
    requireStringArray(value.checkResources, `${field}.checkResources`);
  }
  const finalChecks = value.finalChecks === undefined
    ? []
    : requireStringArray(value.finalChecks, `${field}.finalChecks`);
  finalChecks.forEach((command, index) => {
    if (!command.trim()) {
      throw new Error(`Invalid orchestration ledger field: ${field}.finalChecks.${String(index)}`);
    }
  });
  if (value.finalCheckResources !== undefined) {
    requireStringArray(value.finalCheckResources, `${field}.finalCheckResources`);
  }
  if (value.finalChecksDeclared !== undefined && typeof value.finalChecksDeclared !== "boolean") {
    throw new Error(`Invalid orchestration ledger field: ${field}.finalChecksDeclared`);
  }
  requireInteger(value.priority, `${field}.priority`, -1000, 1000);
  requireInteger(value.retries, `${field}.retries`, 0, 10);
  return {
    ...(value as unknown as TodoTaskSpec),
    ...(pipelineSnapshot ? { pipelineSnapshot } : {}),
  };
};

const validateTaskState = (
  value: unknown,
  field: string,
  runPart: string,
  taskRoot: string,
): OrchestrationTaskState => {
  if (!isRecord(value)) {
    throw new Error(`Invalid orchestration ledger field: ${field}`);
  }
  const spec = validateTaskSpec(value.spec, `${field}.spec`);
  if (typeof value.status !== "string" || !taskStatuses.has(value.status as OrchestrationTaskStatus)) {
    throw new Error(`Invalid orchestration ledger field: ${field}.status`);
  }
  requireInteger(value.attempts, `${field}.attempts`, 0);
  ["conversationId", "commit", "integrationRollbackCommit", "baseTree", "startedAt", "completedAt", "lastError"].forEach((name) => {
    if (value[name] !== undefined) {
      requireString(value[name], `${field}.${name}`);
    }
  });
  if (value.implementationComplete !== undefined && typeof value.implementationComplete !== "boolean") {
    throw new Error(`Invalid orchestration ledger field: ${field}.implementationComplete`);
  }
  if (value.commit !== undefined && !commitPattern.test(value.commit as string)) {
    throw new Error(`Invalid orchestration ledger field: ${field}.commit`);
  }
  if (
    value.integrationRollbackCommit !== undefined &&
    !commitPattern.test(value.integrationRollbackCommit as string)
  ) {
    throw new Error(`Invalid orchestration ledger field: ${field}.integrationRollbackCommit`);
  }
  if (value.integrationRollbackSequence !== undefined) {
    requireInteger(value.integrationRollbackSequence, `${field}.integrationRollbackSequence`, 0);
  }
  if (value.sharedDependencies !== undefined) {
    requireStringArray(value.sharedDependencies, `${field}.sharedDependencies`);
  }
  const worktreeFields = [value.worktreePath, value.branch, value.baseCommit];
  if (worktreeFields.some((item) => item !== undefined) && worktreeFields.some((item) => item === undefined)) {
    throw new Error(`Invalid orchestration ledger field: ${field}.worktree`);
  }
  if (value.worktreePath !== undefined) {
    const worktreePath = requireString(value.worktreePath, `${field}.worktreePath`);
    const branch = requireString(value.branch, `${field}.branch`);
    const baseCommit = requireString(value.baseCommit, `${field}.baseCommit`);
    const taskParts = new Set([legacyStorageIdentity(spec.id), taskStorageIdentity(spec.id)]);
    const worktreePart = path.basename(worktreePath);
    const branchPrefix = `bachata/task/${runPart}/`;
    const branchPart = branch.startsWith(branchPrefix) ? branch.slice(branchPrefix.length) : "";
    if (
      !path.isAbsolute(worktreePath) ||
      path.dirname(path.resolve(worktreePath)) !== path.resolve(taskRoot) ||
      !taskParts.has(worktreePart)
    ) {
      throw new Error(`Invalid orchestration ledger field: ${field}.worktreePath`);
    }
    if (branchPart !== worktreePart) {
      throw new Error(`Invalid orchestration ledger field: ${field}.branch`);
    }
    if (!commitPattern.test(baseCommit)) {
      throw new Error(`Invalid orchestration ledger field: ${field}.baseCommit`);
    }
    if (value.baseTree !== undefined && !commitPattern.test(value.baseTree as string)) {
      throw new Error(`Invalid orchestration ledger field: ${field}.baseTree`);
    }
  } else if (value.baseTree !== undefined) {
    throw new Error(`Invalid orchestration ledger field: ${field}.baseTree`);
  }
  if (value.result !== undefined) {
    if (!isRecord(value.result)) {
      throw new Error(`Invalid orchestration ledger field: ${field}.result`);
    }
    if (!["done", "blocked", "failed", "needsHuman"].includes(String(value.result.status))) {
      throw new Error(`Invalid orchestration ledger field: ${field}.result.status`);
    }
    requireString(value.result.summary, `${field}.result.summary`, true);
    requireStringArray(value.result.changedFiles, `${field}.result.changedFiles`).forEach((item, index) =>
      validateRepositoryPath(item, `${field}.result.changedFiles.${String(index)}`),
    );
    if (!Array.isArray(value.result.checks)) {
      throw new Error(`Invalid orchestration ledger field: ${field}.result.checks`);
    }
    value.result.checks.forEach((check, index) => validateCheck(check, `${field}.result.checks.${String(index)}`));
    requireStringArray(value.result.blockers, `${field}.result.blockers`);
    if (value.result.pipelineStatus !== undefined && !["completed", "interrupted"].includes(String(value.result.pipelineStatus))) {
      throw new Error(`Invalid orchestration ledger field: ${field}.result.pipelineStatus`);
    }
  }
  return { ...(value as unknown as OrchestrationTaskState), spec };
};

const validateLedger = (
  value: unknown,
  expectedRunId: string,
  runsRoot: string,
): OrchestrationLedger => {
  if (!isRecord(value) || value.version !== 1 || value.runId !== expectedRunId) {
    throw new Error(`Invalid orchestration ledger: ${expectedRunId}`);
  }
  requireString(value.title, "title");
  if (typeof value.status !== "string" || !runStatuses.has(value.status as OrchestrationRunStatus)) {
    throw new Error("Invalid orchestration ledger field: status");
  }
  const workspaceRoot = requireString(value.workspaceRoot, "workspaceRoot");
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error("Invalid orchestration ledger field: workspaceRoot");
  }
  if (value.ownerWorkspaceRoot !== undefined) {
    const ownerWorkspaceRoot = requireString(
      value.ownerWorkspaceRoot,
      "ownerWorkspaceRoot",
    );
    if (!path.isAbsolute(ownerWorkspaceRoot)) {
      throw new Error("Invalid orchestration ledger field: ownerWorkspaceRoot");
    }
  }
  if (value.sourceKind !== "todoFile" && value.sourceKind !== "generatedChecklist") {
    throw new Error("Invalid orchestration ledger field: sourceKind");
  }
  if (value.sourceKind === "todoFile") {
    const todoPath = requireString(value.todoPath, "todoPath");
    if (!path.isAbsolute(todoPath) || !contained(workspaceRoot, todoPath) || todoPath === workspaceRoot) {
      throw new Error("Invalid orchestration ledger field: todoPath");
    }
    const sourceHash = requireString(value.todoSourceHash, "todoSourceHash");
    if (!/^[0-9a-f]{64}$/u.test(sourceHash)) {
      throw new Error("Invalid orchestration ledger field: todoSourceHash");
    }
  } else {
    const allowedPaths = requireStringArray(
      value.generatedAllowedPaths,
      "generatedAllowedPaths",
    );
    if (allowedPaths.length === 0) {
      throw new Error("Invalid orchestration ledger field: generatedAllowedPaths");
    }
    const normalizedAllowedPaths = allowedPaths.map((item, index) => {
      validateRepositoryPath(item, `generatedAllowedPaths.${String(index)}`);
      const normalized = normalizeRepositoryPath(item);
      if (normalized !== item) {
        throw new Error(`Invalid orchestration ledger field: generatedAllowedPaths.${String(index)}`);
      }
      return normalized;
    });
    if (new Set(normalizedAllowedPaths).size !== normalizedAllowedPaths.length) {
      throw new Error("Invalid orchestration ledger field: generatedAllowedPaths");
    }
  }
  const integrationBranch = requireString(value.integrationBranch, "integrationBranch");
  if (!integrationBranchPattern.test(integrationBranch)) {
    throw new Error("Invalid orchestration ledger field: integrationBranch");
  }
  const integrationWorktree = requireString(value.integrationWorktree, "integrationWorktree");
  const integrationCandidates = [
    {
      branch: `bachata/integration/${legacyStorageIdentity(expectedRunId)}`,
      worktree: path.join(runsRoot, expectedRunId, "integration"),
    },
    {
      branch: `bachata/integration/${taskStorageIdentity(expectedRunId)}`,
      worktree: path.join(runsRoot, taskStorageIdentity(expectedRunId), "integration"),
    },
  ];
  const integrationOwner = integrationCandidates.find(
    (candidate) =>
      path.resolve(candidate.worktree) === path.resolve(integrationWorktree) &&
      candidate.branch === integrationBranch,
  );
  if (!path.isAbsolute(integrationWorktree) || !integrationOwner) {
    throw new Error("Invalid orchestration ledger field: integrationWorktree");
  }
  const baselineCommit = requireString(value.baselineCommit, "baselineCommit");
  if (!commitPattern.test(baselineCommit)) {
    throw new Error("Invalid orchestration ledger field: baselineCommit");
  }
  if (value.integrationTree !== undefined) {
    const integrationTree = requireString(value.integrationTree, "integrationTree");
    if (!commitPattern.test(integrationTree)) {
      throw new Error("Invalid orchestration ledger field: integrationTree");
    }
  }
  const commitMode = value.commitMode === undefined ? "never" : value.commitMode;
  if (commitMode !== "never" && commitMode !== "allow") {
    throw new Error("Invalid orchestration ledger field: commitMode");
  }
  requireString(value.createdAt, "createdAt");
  requireString(value.updatedAt, "updatedAt");
  requireInteger(value.maxConcurrency, "maxConcurrency", 1, 20);
  if (value.mode !== undefined && value.mode !== "todo" && value.mode !== "selfImprovement") {
    throw new Error("Invalid orchestration ledger field: mode");
  }
  // Re-derived from live workspace approval on resume; validated here so a hand-edited ledger
  // cannot name an authority the workspace never granted.
  if (
    value.repositoryVerifierAuthority !== undefined &&
    value.repositoryVerifierAuthority !== "refused" &&
    value.repositoryVerifierAuthority !== "humanApproved"
  ) {
    throw new Error("Invalid orchestration ledger field: repositoryVerifierAuthority");
  }
  if (value.maxRevisionCycles !== undefined) {
    requireInteger(value.maxRevisionCycles, "maxRevisionCycles", 0, 5);
  }
  if (value.generatedTodo !== undefined) {
    if (!isRecord(value.generatedTodo)) {
      throw new Error("Invalid orchestration ledger field: generatedTodo");
    }
    requireString(value.generatedTodo.source, "generatedTodo.source");
    requireString(value.generatedTodo.candidateHash, "generatedTodo.candidateHash");
    requireString(value.generatedTodo.candidateId, "generatedTodo.candidateId");
    if (value.generatedTodo.ruling !== "accepted" && value.generatedTodo.ruling !== "ruled") {
      throw new Error("Invalid orchestration ledger field: generatedTodo.ruling");
    }
    if (!Array.isArray(value.generatedTodo.tasks)) {
      throw new Error("Invalid orchestration ledger field: generatedTodo.tasks");
    }
    if (!Array.isArray(value.generatedTodo.audits)) {
      throw new Error("Invalid orchestration ledger field: generatedTodo.audits");
    }
  }
  (["reviewPipelineId", "revisionPipelineId"] as const).forEach((name) => {
    const snapshotName = name === "reviewPipelineId" ? "reviewPipelineSnapshot" : "revisionPipelineSnapshot";
    if (value[name] === undefined && value[snapshotName] === undefined) return;
    requireString(value[name], name);
    const snapshot = parsePipelineSnapshot(value[snapshotName]);
    if (
      !snapshot ||
      snapshot.definition.id !== value[name] ||
      snapshot.dependencies !== undefined ||
      snapshot.bundleHash !== undefined
    ) {
      throw new Error(`Invalid orchestration ledger field: ${snapshotName}`);
    }
  });
  ["parentRunRef", "parentConversationId", "userNote", "masterConversationId", "masterPipelineId", "stopRequestedAt", "error"].forEach((name) => {
    if (value[name] !== undefined) {
      requireString(value[name], name, name === "userNote" || name === "error");
    }
  });
  const masterPipelineSnapshot = value.masterPipelineSnapshot === undefined
    ? undefined
    : parsePipelineSnapshot(value.masterPipelineSnapshot);
  if (
    value.masterPipelineSnapshot !== undefined &&
    (!masterPipelineSnapshot ||
      masterPipelineSnapshot.definition.id !== value.masterPipelineId ||
      masterPipelineSnapshot.dependencies !== undefined ||
      masterPipelineSnapshot.bundleHash !== undefined)
  ) {
    throw new Error("Invalid orchestration ledger field: masterPipelineSnapshot");
  }
  if (!Array.isArray(value.masterChecks) || !Array.isArray(value.finalChecks)) {
    throw new Error("Invalid orchestration ledger checks");
  }
  if (value.acceptedIntegrations !== undefined) {
    requireInteger(value.acceptedIntegrations, "acceptedIntegrations", 0);
  }
  value.masterChecks.forEach((check, index) => {
    if (!isRecord(check)) {
      throw new Error(`Invalid orchestration ledger field: masterChecks.${String(index)}`);
    }
    requireString(check.checkedAt, `masterChecks.${String(index)}.checkedAt`);
    if (check.phase !== "schedule" && check.phase !== "terminal") {
      throw new Error(`Invalid orchestration ledger field: masterChecks.${String(index)}.phase`);
    }
    if (check.status !== "continue" && check.status !== "deviation") {
      throw new Error(`Invalid orchestration ledger field: masterChecks.${String(index)}.status`);
    }
    if (!Array.isArray(check.deviations)) {
      throw new Error(`Invalid orchestration ledger field: masterChecks.${String(index)}.deviations`);
    }
    check.deviations.forEach((deviation, deviationIndex) => {
      const field = `masterChecks.${String(index)}.deviations.${String(deviationIndex)}`;
      if (!isRecord(deviation)) {
        throw new Error(`Invalid orchestration ledger field: ${field}`);
      }
      const taskId = requireString(deviation.taskId, `${field}.taskId`);
      if (!taskIdPattern.test(taskId)) {
        throw new Error(`Invalid orchestration ledger field: ${field}.taskId`);
      }
      if (typeof deviation.kind !== "string" || !masterDeviationKinds.has(deviation.kind)) {
        throw new Error(`Invalid orchestration ledger field: ${field}.kind`);
      }
      requireString(deviation.details, `${field}.details`);
    });
    requireString(check.conversationId, `masterChecks.${String(index)}.conversationId`);
  });
  value.finalChecks.forEach((check, index) => validateCheck(check, `finalChecks.${String(index)}`));
  // P3. What has been verified about the retained candidate, by fingerprint. Persisted state is
  // read back after a reload, so it is validated rather than trusted: an entry whose fingerprint
  // or checks are not what they claim would otherwise be able to authorize an Apply.
  if (value.retainedEvidence !== undefined) {
    if (!Array.isArray(value.retainedEvidence)) {
      throw new Error("Invalid orchestration ledger field: retainedEvidence");
    }
    value.retainedEvidence.forEach((entry, index) => {
      const field = `retainedEvidence.${String(index)}`;
      if (!isRecord(entry)) throw new Error(`Invalid orchestration ledger field: ${field}`);
      const fingerprint = requireString(entry.fingerprint, `${field}.fingerprint`);
      if (!commitPattern.test(fingerprint)) {
        throw new Error(`Invalid orchestration ledger field: ${field}.fingerprint`);
      }
      if (!Array.isArray(entry.checks)) {
        throw new Error(`Invalid orchestration ledger field: ${field}.checks`);
      }
      entry.checks.forEach((check, checkIndex) =>
        validateCheck(check, `${field}.checks.${String(checkIndex)}`),
      );
    });
  }
  if (value.finalCheckCommands !== undefined) {
    requireStringArray(value.finalCheckCommands, "finalCheckCommands");
  }
  if (value.finalCheckResources !== undefined) {
    requireStringArray(value.finalCheckResources, "finalCheckResources");
  }
  const humanDecisionBlockers = value.humanDecisionBlockers === undefined
    ? []
    : requireStringArray(value.humanDecisionBlockers, "humanDecisionBlockers");
  if (value.generatedTodoPath !== undefined) {
    const generatedTodoPath = requireString(value.generatedTodoPath, "generatedTodoPath");
    validateRepositoryPath(generatedTodoPath, "generatedTodoPath");
    if (normalizeRepositoryPath(generatedTodoPath) !== generatedTodoPath) {
      throw new Error("Invalid orchestration ledger field: generatedTodoPath");
    }
  }
  // A run that stopped on a human-owned decision may legitimately carry no task at all: the
  // point of persisting it is the question, not the work.
  if (!isRecord(value.tasks) ||
    (Object.keys(value.tasks).length === 0 && humanDecisionBlockers.length === 0)) {
    throw new Error("Invalid orchestration ledger field: tasks");
  }
  const runPart = integrationBranch.slice("bachata/integration/".length);
  const taskRoot = path.join(path.dirname(integrationWorktree), "tasks");
  const tasks = Object.fromEntries(Object.entries(value.tasks).map(([id, task]) => {
    if (!taskIdPattern.test(id)) {
      throw new Error(`Invalid orchestration task key: ${id}`);
    }
    const validated = validateTaskState(task, `tasks.${id}`, runPart, taskRoot);
    if (validated.spec.id !== id) {
      throw new Error(`Orchestration task key does not match spec id: ${id}`);
    }
    return [id, validated];
  }));
  if (value.sourceKind === "generatedChecklist") {
    const allowedPaths = value.generatedAllowedPaths as string[];
    Object.values(tasks).forEach((task) => {
      task.spec.paths.forEach((taskPath) => {
        const normalized = normalizeRepositoryPath(taskPath);
        if (!allowedPaths.some((allowedPath) => pathWithinScope(normalized, allowedPath))) {
          throw new Error(
            `Generated orchestration task ${task.spec.id} exceeds persisted allowed paths: ${taskPath}`,
          );
        }
      });
    });
  }
  value.masterChecks.forEach((check, index) => {
    (check as Record<string, unknown>).deviations && ((check as Record<string, unknown>).deviations as unknown[]).forEach((deviation, deviationIndex) => {
      const taskId = (deviation as Record<string, unknown>).taskId as string;
      if (!tasks[taskId]) {
        throw new Error(`Invalid orchestration ledger field: masterChecks.${String(index)}.deviations.${String(deviationIndex)}.taskId`);
      }
    });
  });
  Object.values(tasks).forEach((task) => {
    task.spec.dependsOn.forEach((dependency) => {
      if (!tasks[dependency] || dependency === task.spec.id) {
        throw new Error(`Invalid dependency for orchestration task ${task.spec.id}: ${dependency}`);
      }
    });
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) {
      return;
    }
    if (visiting.has(taskId)) {
      throw new Error(`Invalid orchestration dependency cycle: ${taskId}`);
    }
    visiting.add(taskId);
    tasks[taskId]?.spec.dependsOn.forEach(visit);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  Object.keys(tasks).forEach(visit);
  return {
    ...(value as unknown as OrchestrationLedger),
    tasks,
    ...(value.commitMode === "never" || value.commitMode === "allow" ? { commitMode } : {}),
    ...(masterPipelineSnapshot ? { masterPipelineSnapshot } : {}),
  };
};

export type OrchestrationStore = {
  root: string;
  ledgerPath: (runId: string) => string;
  save: (ledger: OrchestrationLedger) => Promise<void>;
  load: (runId: string) => Promise<OrchestrationLedger>;
  listRunIds: () => Promise<string[]>;
  remove: (runId: string) => Promise<void>;
  setActiveRun: (runId: string | undefined) => Promise<void>;
  getActiveRun: () => Promise<string | undefined>;
};

export const createOrchestrationStore = (
  storageRoot: string,
  options: {
    withMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  } = {},
): OrchestrationStore => {
  const root = path.resolve(storageRoot, "orchestration");
  const runsRoot = path.join(root, "runs");
  const activePath = path.join(root, "active-run.json");
  const assertRunId = (runId: string): void => {
    if (!safeSegmentPattern.test(runId)) {
      throw new Error(`Invalid orchestration run id: ${runId}`);
    }
  };
  const ledgerPath = (runId: string): string => {
    assertRunId(runId);
    return path.join(runsRoot, runId, "ledger.json");
  };
  let writeQueue = Promise.resolve();
  const withMutation = options.withMutation ?? (async <T>(operation: () => Promise<T>): Promise<T> => operation());
  const enqueueWrite = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    root,
    ledgerPath,
    save: (ledger) => {
      assertRunId(ledger.runId);
      ledger.updatedAt = new Date().toISOString();
      const validated = validateLedger(ledger, ledger.runId, runsRoot);
      const filePath = ledgerPath(validated.runId);
      const content = `${JSON.stringify(validated, null, 2)}\n`;
      return enqueueWrite(() => withMutation(() => atomicWrite(filePath, content)));
    },
    load: async (runId) => {
      assertRunId(runId);
      const parsed = JSON.parse(await readFile(ledgerPath(runId), "utf8")) as unknown;
      if (isRecord(parsed)) {
        parsed.sourceKind ??= parsed.todoPath ? "todoFile" : "generatedChecklist";
        parsed.title ||= "TODO run";
        parsed.masterChecks ??= [];
      }
      return validateLedger(parsed, runId, runsRoot);
    },
    listRunIds: async () => {
      const entries = await readdir(runsRoot, { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      });
      const candidates = entries
        .filter((entry) => entry.isDirectory() && safeSegmentPattern.test(entry.name))
        .map((entry) => entry.name);
      const ledgers = await Promise.all(candidates.map(async (runId) => {
        try {
          const details = await stat(ledgerPath(runId));
          return details.isFile() ? runId : undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      }));
      return ledgers.filter((runId): runId is string => Boolean(runId)).sort();
    },
    remove: (runId) => {
      assertRunId(runId);
      return enqueueWrite(() => withMutation(() =>
        rm(path.dirname(ledgerPath(runId)), { recursive: true, force: true })
      ));
    },
    setActiveRun: (runId) =>
      enqueueWrite(() => withMutation(async () => {
        if (!runId) {
          await rm(activePath, { force: true });
          return;
        }
        assertRunId(runId);
        await atomicWrite(activePath, `${JSON.stringify({ version: 1, runId })}\n`);
      })),
    getActiveRun: async () => {
      try {
        const value = JSON.parse(await readFile(activePath, "utf8")) as unknown;
        if (!isRecord(value) || value.version !== 1 || typeof value.runId !== "string") {
          throw new Error("Invalid active orchestration run pointer");
        }
        assertRunId(value.runId);
        return value.runId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
  };
};
