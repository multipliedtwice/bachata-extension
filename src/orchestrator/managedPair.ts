import { createHash } from "node:crypto";

import type { WorkspaceWriteScope } from "../adapters/types";
import { resolveWorkspaceWritePolicy } from "../adapters/workspacePolicyAudit";

export type ManagedPairState =
  | "PREPARE_HANDOFF"
  | "WORKER_NEEDS_CONTEXT"
  | "WORKER_APPLY_PATCH"
  | "WORKER_VERIFY"
  | "LEAD_REVIEW"
  | "LEAD_NEEDS_CONTEXT"
  | "WORKER_REVISE"
  | "LEAD_FINAL_REVIEW"
  | "FINALIZE"
  | "BLOCKED";

export type ManagedPairPolicy = {
  writeScope: WorkspaceWriteScope;
  commitMode: "never";
  leadReadOnly: boolean;
  maxRevisionCycles: number;
  readPaths: string[];
  allowedPaths: string[];
  protectedPaths?: string[];
  requiredVerificationCheckIds: string[];
  verificationPlanHash: string;
};

export type VerificationRecord = {
  id: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  scope?: "workspaceIntegrity" | "controllerProjectChecks";
  workspaceFingerprint: string;
};

export type ManagedRepositoryBaselineEntry = {
  path: string;
  fingerprint: string;
};

export type ManagedRepositoryBaseline = {
  isGitRepository: boolean;
  head: string;
  entries: ManagedRepositoryBaselineEntry[];
};

export type ManagedPairCheckpoint = {
  protocol: "bachata-managed-checkpoint-v1";
  taskId: string;
  taskHash: string;
  deadlineAt: number;
  originalTask: string;
  constraints: string[];
  policy: ManagedPairPolicy;
  state: ManagedPairState;
  workspaceRevision: number;
  workspaceFingerprint?: string;
  worktreePath: string;
  changedFiles: string[];
  diffSummary: string;
  verification: VerificationRecord[];
  unresolved: string[];
  revisionCycles: number;
  attemptedAgents: string[];
  providerFailures: Array<{
    agentId: string;
    code: string;
    sideEffects: "none" | "possible" | "confirmed";
  }>;
  repositoryBaseline?: ManagedRepositoryBaseline;
};

export type ManagedPairEvent =
  | { type: "prepared" }
  | { type: "workerNeedsContext" }
  | { type: "workerRequestedPatch" }
  | { type: "patchApplied"; changedFiles: string[]; diffSummary: string; workspaceFingerprint?: string; repositoryBaseline?: ManagedRepositoryBaseline }
  | { type: "verificationRequested" }
  | { type: "verificationCompleted"; verification: VerificationRecord[]; workspaceFingerprint?: string; repositoryBaseline?: ManagedRepositoryBaseline }
  | { type: "workerDone" }
  | { type: "leadNeedsContext" }
  | { type: "leadAccepted" }
  | { type: "leadRequestedRevision"; objections: string[] }
  | { type: "revisionApplied"; changedFiles: string[]; diffSummary: string; workspaceFingerprint?: string; repositoryBaseline?: ManagedRepositoryBaseline }
  | { type: "providerFailed"; agentId: string; code: string; sideEffects: "none" | "possible" | "confirmed" }
  | { type: "blocked"; reason: string };

function normalizeManagedPath(value: string): string {
  const platformPath = process.platform === "win32" ? value.replace(/\\/g, "/") : value;
  return platformPath.replace(/^\.\//, "");
}

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((value) => value.length > 0).map(normalizeManagedPath))].sort();
}

function normalizeWorkspacePathForBaseline(value: string): string {
  return normalizeManagedPath(value);
}


function verificationPlanHash(checks: Array<{ id: string; command: string }>): string {
  const normalized = checks
    .map((check) => ({ id: check.id.trim(), command: check.command.trim() }))
    .filter((check) => check.id && check.command)
    .sort((left, right) => left.id.localeCompare(right.id) || left.command.localeCompare(right.command));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function hashTask(task: string, constraints: string[], policy: ManagedPairPolicy, worktreePath: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ task, constraints, policy, worktreePath }))
    .digest("hex");
}

export function computeManagedWorkspaceFingerprint(input: {
  taskHash: string;
  repositoryBaseline: ManagedRepositoryBaseline;
}): string {
  const baseline = {
    isGitRepository: input.repositoryBaseline.isGitRepository,
    head: input.repositoryBaseline.head,
    entries: [...input.repositoryBaseline.entries]
      .map((entry) => ({ path: normalizeWorkspacePathForBaseline(entry.path), fingerprint: entry.fingerprint }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  return createHash("sha256")
    .update(JSON.stringify({ taskHash: input.taskHash, baseline }))
    .digest("hex");
}

export function createManagedPairCheckpoint(input: {
  taskId: string;
  originalTask: string;
  constraints?: string[];
  worktreePath: string;
  readPaths?: string[];
  writeScope?: WorkspaceWriteScope;
  allowedPaths?: string[];
  protectedPaths?: string[];
  commitMode?: "never" | "allow";
  maxRevisionCycles?: number;
  requiredVerificationCheckIds?: string[];
  verificationChecks?: Array<{ id: string; command: string }>;
  deadlineAt?: number;
}): ManagedPairCheckpoint {
  const normalizedVerificationChecks = (input.verificationChecks ?? [])
    .map((check) => ({ id: check.id.trim(), command: check.command.trim() }))
    .filter((check) => check.id && check.command);
  const requiredVerificationCheckIds = normalizedVerificationChecks.length > 0
    ? normalizedVerificationChecks.map((check) => check.id)
    : input.requiredVerificationCheckIds ?? [];
  const protectedPaths = normalizePaths(input.protectedPaths ?? []);
  const resolvedWritePolicy = resolveWorkspaceWritePolicy({
    task: input.originalTask,
    workspaceRoot: input.worktreePath,
    ...(input.writeScope === undefined ? {} : { writeScope: input.writeScope }),
    ...(input.allowedPaths === undefined ? {} : { allowedPaths: input.allowedPaths }),
    defaultScope: "task",
  });
  const policy: ManagedPairPolicy = {
    writeScope: resolvedWritePolicy.writeScope,
    commitMode: "never",
    leadReadOnly: true,
    maxRevisionCycles: Math.max(0, Math.min(input.maxRevisionCycles ?? 1, 2)),
    readPaths: normalizePaths(input.readPaths ?? []),
    allowedPaths: normalizePaths(resolvedWritePolicy.allowedPaths),
    ...(protectedPaths.length > 0 ? { protectedPaths } : {}),
    requiredVerificationCheckIds: [...new Set(requiredVerificationCheckIds.map((value) => value.trim()).filter(Boolean))].sort(),
    verificationPlanHash: verificationPlanHash(
      normalizedVerificationChecks.length > 0
        ? normalizedVerificationChecks
        : [...new Set(requiredVerificationCheckIds.map((value) => value.trim()).filter(Boolean))].sort().map((id) => ({ id, command: "<unspecified>" })),
    ),
  };
  const constraints = [...new Set([...(input.constraints ?? []), ...(policy.commitMode === "never" ? ["Do not commit changes."] : [])])];
  return {
    protocol: "bachata-managed-checkpoint-v1",
    taskId: input.taskId,
    taskHash: hashTask(input.originalTask, constraints, policy, input.worktreePath),
    deadlineAt: Math.max(Date.now() + 1_000, Math.floor(input.deadlineAt ?? Date.now() + 2 * 60 * 60 * 1_000)),
    originalTask: input.originalTask,
    constraints,
    policy,
    state: "PREPARE_HANDOFF",
    workspaceRevision: 0,
    worktreePath: input.worktreePath,
    changedFiles: [],
    diffSummary: "",
    verification: [],
    unresolved: [],
    revisionCycles: 0,
    attemptedAgents: [],
    providerFailures: [],
  };
}

function withMutation(
  checkpoint: ManagedPairCheckpoint,
  changedFiles: string[],
  diffSummary: string,
  state: ManagedPairState,
  workspaceFingerprint?: string,
  repositoryBaseline?: ManagedRepositoryBaseline,
): ManagedPairCheckpoint {
  const { workspaceFingerprint: _previousFingerprint, repositoryBaseline: _previousBaseline, ...base } = checkpoint;
  return {
    ...base,
    state,
    workspaceRevision: checkpoint.workspaceRevision + 1,
    changedFiles: normalizePaths([...checkpoint.changedFiles, ...changedFiles]),
    diffSummary: diffSummary.slice(0, 32_768),
    verification: [],
    ...(workspaceFingerprint ? { workspaceFingerprint } : {}),
    ...(repositoryBaseline ? { repositoryBaseline } : {}),
  };
}

function assertTransition(checkpoint: ManagedPairCheckpoint, allowed: ManagedPairState[], event: string): void {
  if (!allowed.includes(checkpoint.state)) {
    throw new Error(`Invalid managed pair transition ${event} from ${checkpoint.state}`);
  }
}

function requiredVerificationPassed(checkpoint: ManagedPairCheckpoint): boolean {
  if (!checkpoint.workspaceFingerprint || !/^[0-9a-f]{64}$/u.test(checkpoint.workspaceFingerprint)) return false;
  const byId = new Map(checkpoint.verification.map((record) => [record.id, record]));
  return checkpoint.policy.requiredVerificationCheckIds.every((id) => {
    const record = byId.get(id);
    return record?.status === "passed" && record.workspaceFingerprint === checkpoint.workspaceFingerprint;
  });
}

export function advanceManagedPair(
  checkpoint: ManagedPairCheckpoint,
  event: ManagedPairEvent,
): ManagedPairCheckpoint {
  if (checkpoint.state === "FINALIZE" || checkpoint.state === "BLOCKED") {
    if (event.type !== "providerFailed") {
      throw new Error(`Managed pair is terminal: ${checkpoint.state}`);
    }
  }

  switch (event.type) {
    case "prepared":
      assertTransition(checkpoint, ["PREPARE_HANDOFF"], event.type);
      return { ...checkpoint, state: "WORKER_NEEDS_CONTEXT" };
    case "workerNeedsContext":
      assertTransition(checkpoint, ["WORKER_NEEDS_CONTEXT", "WORKER_APPLY_PATCH", "WORKER_VERIFY", "WORKER_REVISE"], event.type);
      return { ...checkpoint, state: "WORKER_NEEDS_CONTEXT" };
    case "workerRequestedPatch":
      assertTransition(checkpoint, ["WORKER_NEEDS_CONTEXT", "WORKER_APPLY_PATCH", "WORKER_VERIFY", "WORKER_REVISE"], event.type);
      return { ...checkpoint, state: checkpoint.revisionCycles > 0 ? "WORKER_REVISE" : "WORKER_APPLY_PATCH" };
    case "patchApplied":
      assertTransition(checkpoint, ["WORKER_APPLY_PATCH"], event.type);
      return withMutation(checkpoint, event.changedFiles, event.diffSummary, "WORKER_VERIFY", event.workspaceFingerprint, event.repositoryBaseline);
    case "revisionApplied":
      assertTransition(checkpoint, ["WORKER_REVISE"], event.type);
      return withMutation(checkpoint, event.changedFiles, event.diffSummary, "WORKER_VERIFY", event.workspaceFingerprint, event.repositoryBaseline);
    case "verificationRequested":
      assertTransition(checkpoint, ["WORKER_VERIFY"], event.type);
      return checkpoint;
    case "verificationCompleted":
      assertTransition(checkpoint, ["WORKER_NEEDS_CONTEXT", "WORKER_APPLY_PATCH", "WORKER_VERIFY", "WORKER_REVISE"], event.type);
      if (!event.workspaceFingerprint || !/^[0-9a-f]{64}$/u.test(event.workspaceFingerprint)) {
        throw new Error("Managed verification result is missing the authoritative workspace fingerprint");
      }
      if (event.verification.some((record) => record.workspaceFingerprint !== event.workspaceFingerprint)) {
        throw new Error("Managed verification evidence does not match the authoritative workspace fingerprint");
      }
      return {
        ...checkpoint,
        verification: event.verification,
        state: "WORKER_VERIFY",
        workspaceFingerprint: event.workspaceFingerprint,
        ...(event.repositoryBaseline ? { repositoryBaseline: event.repositoryBaseline } : {}),
      };
    case "workerDone":
      assertTransition(checkpoint, ["WORKER_NEEDS_CONTEXT", "WORKER_APPLY_PATCH", "WORKER_VERIFY", "WORKER_REVISE"], event.type);
      if (!requiredVerificationPassed(checkpoint)) {
        throw new Error("Managed Worker cannot finish before all required verification checks pass");
      }
      return { ...checkpoint, state: checkpoint.revisionCycles >= checkpoint.policy.maxRevisionCycles ? "LEAD_FINAL_REVIEW" : "LEAD_REVIEW" };
    case "leadNeedsContext":
      assertTransition(checkpoint, ["LEAD_REVIEW", "LEAD_FINAL_REVIEW", "LEAD_NEEDS_CONTEXT"], event.type);
      return { ...checkpoint, state: "LEAD_NEEDS_CONTEXT" };
    case "leadAccepted":
      assertTransition(checkpoint, ["LEAD_REVIEW", "LEAD_FINAL_REVIEW", "LEAD_NEEDS_CONTEXT"], event.type);
      if (!requiredVerificationPassed(checkpoint)) {
        throw new Error("Managed Lead cannot accept before all required verification checks pass");
      }
      return { ...checkpoint, state: "FINALIZE", unresolved: [] };
    case "leadRequestedRevision": {
      assertTransition(checkpoint, ["LEAD_REVIEW", "LEAD_FINAL_REVIEW", "LEAD_NEEDS_CONTEXT"], event.type);
      if (checkpoint.revisionCycles >= checkpoint.policy.maxRevisionCycles) {
        return { ...checkpoint, state: "BLOCKED", unresolved: event.objections };
      }
      return {
        ...checkpoint,
        state: "WORKER_REVISE",
        unresolved: event.objections,
        revisionCycles: checkpoint.revisionCycles + 1,
      };
    }
    case "providerFailed":
      return {
        ...checkpoint,
        attemptedAgents: [...new Set([...checkpoint.attemptedAgents, event.agentId])],
        providerFailures: [
          ...checkpoint.providerFailures,
          { agentId: event.agentId, code: event.code, sideEffects: event.sideEffects },
        ],
      };
    case "blocked":
      return { ...checkpoint, state: "BLOCKED", unresolved: [event.reason] };
  }
}

export function validateManagedCompletion(checkpoint: ManagedPairCheckpoint): {
  valid: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (checkpoint.state !== "FINALIZE") {
    reasons.push("stateNotFinalized");
  }
  const verificationById = new Map(checkpoint.verification.map((record) => [record.id, record]));
  const missingVerification = checkpoint.policy.requiredVerificationCheckIds.filter((id) => !verificationById.has(id));
  if (missingVerification.length > 0) {
    reasons.push("verificationMissing");
  }
  if (!checkpoint.workspaceFingerprint
    || checkpoint.policy.requiredVerificationCheckIds.some((id) => {
      const record = verificationById.get(id);
      return record?.status !== "passed" || record.workspaceFingerprint !== checkpoint.workspaceFingerprint;
    })) {
    reasons.push("verificationFailed");
  }
  if (checkpoint.unresolved.length > 0) {
    reasons.push("unresolvedIssues");
  }
  return { valid: reasons.length === 0, reasons };
}

const managedStates = new Set<ManagedPairState>([
  "PREPARE_HANDOFF",
  "WORKER_NEEDS_CONTEXT",
  "WORKER_APPLY_PATCH",
  "WORKER_VERIFY",
  "LEAD_REVIEW",
  "LEAD_NEEDS_CONTEXT",
  "WORKER_REVISE",
  "LEAD_FINAL_REVIEW",
  "FINALIZE",
  "BLOCKED",
]);

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;

export function parseManagedPairCheckpoint(value: unknown): ManagedPairCheckpoint | undefined {
  const record = recordValue(value);
  const policyRecord = recordValue(record?.policy);
  if (!record || !policyRecord || record.protocol !== "bachata-managed-checkpoint-v1") {
    return undefined;
  }
  const constraints = stringArray(record.constraints);
  const changedFiles = stringArray(record.changedFiles);
  const unresolved = stringArray(record.unresolved);
  const attemptedAgents = stringArray(record.attemptedAgents);
  const writeScope = ["task", "configured", "workspace", "readOnly"].includes(String(policyRecord.writeScope))
    ? policyRecord.writeScope as WorkspaceWriteScope
    : undefined;
  const readPaths = policyRecord.readPaths === undefined ? [] : stringArray(policyRecord.readPaths);
  const allowedPaths = stringArray(policyRecord.allowedPaths);
  const protectedPaths = policyRecord.protectedPaths === undefined
    ? []
    : stringArray(policyRecord.protectedPaths);
  const requiredVerificationCheckIds = stringArray(policyRecord.requiredVerificationCheckIds);
  if (
    typeof record.taskId !== "string" || !record.taskId
    || !Number.isSafeInteger(record.deadlineAt) || Number(record.deadlineAt) <= 0
    || typeof record.taskHash !== "string" || !/^[0-9a-f]{64}$/u.test(record.taskHash)
    || typeof record.originalTask !== "string"
    || !constraints || !changedFiles || !unresolved || !attemptedAgents
    || typeof record.state !== "string" || !managedStates.has(record.state as ManagedPairState)
    || !Number.isSafeInteger(record.workspaceRevision) || Number(record.workspaceRevision) < 0
    || typeof record.worktreePath !== "string" || !record.worktreePath
    || typeof record.diffSummary !== "string"
    || (record.workspaceFingerprint !== undefined
      && (typeof record.workspaceFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(record.workspaceFingerprint)))
    || !Number.isSafeInteger(record.revisionCycles) || Number(record.revisionCycles) < 0
    || !writeScope || !readPaths || !allowedPaths || !protectedPaths || !requiredVerificationCheckIds
    || typeof policyRecord.verificationPlanHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(policyRecord.verificationPlanHash)
    || policyRecord.commitMode !== "never"
    || policyRecord.leadReadOnly !== true
    || !Number.isSafeInteger(policyRecord.maxRevisionCycles)
    || Number(policyRecord.maxRevisionCycles) < 0
    || Number(policyRecord.maxRevisionCycles) > 2
  ) {
    return undefined;
  }

  if (!Array.isArray(record.verification) || !record.verification.every((entry) => {
    const item = recordValue(entry);
    return item
      && typeof item.id === "string"
      && (item.status === "passed" || item.status === "failed" || item.status === "skipped")
      && typeof item.summary === "string"
      && typeof item.workspaceFingerprint === "string"
      && /^[0-9a-f]{64}$/u.test(item.workspaceFingerprint)
      && (item.scope === undefined
        || item.scope === "workspaceIntegrity"
        || item.scope === "controllerProjectChecks");
  })) {
    return undefined;
  }
  const parsedVerification = record.verification as VerificationRecord[];
  if (parsedVerification.length > 0) {
    if (typeof record.workspaceFingerprint !== "string"
      || parsedVerification.some((entry) => entry.workspaceFingerprint !== record.workspaceFingerprint)) {
      return undefined;
    }
  }
  if (!Array.isArray(record.providerFailures) || !record.providerFailures.every((entry) => {
    const item = recordValue(entry);
    return item
      && typeof item.agentId === "string"
      && typeof item.code === "string"
      && (item.sideEffects === "none" || item.sideEffects === "possible" || item.sideEffects === "confirmed");
  })) {
    return undefined;
  }

  let repositoryBaseline: ManagedRepositoryBaseline | undefined;
  if (record.repositoryBaseline !== undefined) {
    const baselineRecord = recordValue(record.repositoryBaseline);
    if (!baselineRecord
      || typeof baselineRecord.isGitRepository !== "boolean"
      || typeof baselineRecord.head !== "string"
      || !Array.isArray(baselineRecord.entries)
      || !baselineRecord.entries.every((entry) => {
        const item = recordValue(entry);
        return item
          && typeof item.path === "string"
          && typeof item.fingerprint === "string"
          && /^[0-9a-f]{64}$/u.test(item.fingerprint);
      })) {
      return undefined;
    }
    repositoryBaseline = {
      isGitRepository: baselineRecord.isGitRepository,
      head: baselineRecord.head,
      entries: (baselineRecord.entries as ManagedRepositoryBaselineEntry[])
        .map((entry) => ({
          path: normalizeWorkspacePathForBaseline(entry.path),
          fingerprint: entry.fingerprint,
        }))
        .filter((entry) => entry.path.length > 0)
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  if ((typeof record.workspaceFingerprint === "string") !== Boolean(repositoryBaseline)) {
    return undefined;
  }

  const normalizedProtectedPaths = normalizePaths(protectedPaths);
  const policy: ManagedPairPolicy = {
    writeScope,
    commitMode: "never",
    leadReadOnly: true,
    maxRevisionCycles: Number(policyRecord.maxRevisionCycles),
    readPaths: normalizePaths(readPaths),
    allowedPaths: normalizePaths(allowedPaths),
    ...(normalizedProtectedPaths.length > 0 ? { protectedPaths: normalizedProtectedPaths } : {}),
    requiredVerificationCheckIds: [...new Set(requiredVerificationCheckIds.map((entry) => entry.trim()).filter(Boolean))].sort(),
    verificationPlanHash: policyRecord.verificationPlanHash,
  };
  const normalizedConstraints = [...new Set(constraints)];
  const currentTaskHash = hashTask(record.originalTask, normalizedConstraints, policy, record.worktreePath);
  if (currentTaskHash !== record.taskHash) {
    return undefined;
  }
  if (repositoryBaseline && typeof record.workspaceFingerprint === "string") {
    const expectedWorkspaceFingerprint = computeManagedWorkspaceFingerprint({
      taskHash: currentTaskHash,
      repositoryBaseline,
    });
    if (expectedWorkspaceFingerprint !== record.workspaceFingerprint) {
      return undefined;
    }
  }

  return {
    protocol: "bachata-managed-checkpoint-v1",
    taskId: record.taskId,
    taskHash: record.taskHash,
    deadlineAt: Number(record.deadlineAt),
    originalTask: record.originalTask,
    constraints: normalizedConstraints,
    policy,
    state: record.state as ManagedPairState,
    workspaceRevision: Number(record.workspaceRevision),
    ...(typeof record.workspaceFingerprint === "string" ? { workspaceFingerprint: record.workspaceFingerprint } : {}),
    worktreePath: record.worktreePath,
    changedFiles: normalizePaths(changedFiles),
    diffSummary: record.diffSummary.slice(0, 32_768),
    verification: parsedVerification.map((entry) => ({ ...entry })),
    unresolved: [...unresolved],
    revisionCycles: Number(record.revisionCycles),
    attemptedAgents: [...new Set(attemptedAgents)],
    providerFailures: (record.providerFailures as ManagedPairCheckpoint["providerFailures"]).map((entry) => ({ ...entry })),
    ...(repositoryBaseline ? { repositoryBaseline } : {}),
  };
}
