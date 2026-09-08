import * as path from "node:path";
import { readFile } from "node:fs/promises";

import type { WorkspaceWriteScope } from "../adapters/types";

export const REPOSITORY_POLICY_PATH = ".bachata/policy.json";

export type RepositoryPolicy = {
  version: 1;
  approvedPipelineIds?: string[];
  maxWriteScope?: WorkspaceWriteScope;
  commitMode?: "never" | "allow";
  allowedVerifiers?: string[];
  protectedPaths?: string[];
  requireHumanGate?: boolean;
};

export type RepositoryPolicyLoad = {
  present: boolean;
  policy?: RepositoryPolicy;
  errors: string[];
};

const WRITE_SCOPE_RANK: Record<WorkspaceWriteScope, number> = {
  readOnly: 0,
  task: 1,
  configured: 2,
  workspace: 3,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (
  value: unknown,
  label: string,
  errors: string[],
): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    errors.push(`${label} must be an array of non-empty strings`);
    return undefined;
  }
  if (value.length > 256) {
    errors.push(`${label} declares more than 256 entries`);
    return undefined;
  }
  return (value as string[]).map((item) => item.trim());
};

export const parseRepositoryPolicy = (
  value: unknown,
): { policy?: RepositoryPolicy; errors: string[] } => {
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: ["The repository policy must be a JSON object"] };
  const allowed = new Set([
    "version", "approvedPipelineIds", "maxWriteScope", "commitMode",
    "allowedVerifiers", "protectedPaths", "requireHumanGate",
  ]);
  Object.keys(value)
    .filter((key) => !allowed.has(key))
    .forEach((key) => errors.push(`The repository policy has an unknown key: ${key}`));
  if (value.version !== 1) errors.push('The repository policy must declare "version": 1');
  const approvedPipelineIds = stringList(value.approvedPipelineIds, "approvedPipelineIds", errors);
  const allowedVerifiers = stringList(value.allowedVerifiers, "allowedVerifiers", errors);
  const protectedPaths = stringList(value.protectedPaths, "protectedPaths", errors);
  if (
    value.maxWriteScope !== undefined &&
    !["readOnly", "task", "configured", "workspace"].includes(String(value.maxWriteScope))
  ) {
    errors.push("maxWriteScope must be readOnly, task, configured, or workspace");
  }
  if (value.commitMode !== undefined && value.commitMode !== "never" && value.commitMode !== "allow") {
    errors.push('commitMode must be "never" or "allow"');
  }
  if (value.requireHumanGate !== undefined && typeof value.requireHumanGate !== "boolean") {
    errors.push("requireHumanGate must be a boolean");
  }
  if (errors.length > 0) return { errors };
  return {
    policy: {
      version: 1,
      ...(approvedPipelineIds === undefined ? {} : { approvedPipelineIds }),
      ...(value.maxWriteScope === undefined
        ? {}
        : { maxWriteScope: value.maxWriteScope as WorkspaceWriteScope }),
      ...(value.commitMode === undefined ? {} : { commitMode: value.commitMode as "never" | "allow" }),
      ...(allowedVerifiers === undefined ? {} : { allowedVerifiers }),
      ...(protectedPaths === undefined ? {} : { protectedPaths }),
      ...(value.requireHumanGate === undefined
        ? {}
        : { requireHumanGate: value.requireHumanGate as boolean }),
    },
    errors: [],
  };
};

export const loadRepositoryPolicy = async (
  repositoryRoot: string,
): Promise<RepositoryPolicyLoad> => {
  let source: string;
  try {
    source = await readFile(path.join(repositoryRoot, ...REPOSITORY_POLICY_PATH.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, errors: [] };
    return {
      present: true,
      errors: [`${REPOSITORY_POLICY_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return {
      present: true,
      errors: [`${REPOSITORY_POLICY_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = parseRepositoryPolicy(value);
  return parsed.policy
    ? { present: true, policy: parsed.policy, errors: [] }
    : { present: true, errors: parsed.errors.map((message) => `${REPOSITORY_POLICY_PATH}: ${message}`) };
};

export type PolicySubject = {
  pipelineId: string;
  writeScope: WorkspaceWriteScope;
  commitPolicy: "never" | "allow";
  verification: string[];
  protectedPaths: string[];
  humanGateCount: number;
};

export const repositoryPolicyRefusals = (
  policy: RepositoryPolicy | undefined,
  subject: PolicySubject,
): string[] => {
  if (!policy) return [];
  const refusals: string[] = [];
  if (policy.approvedPipelineIds && !policy.approvedPipelineIds.includes(subject.pipelineId)) {
    refusals.push(
      `${REPOSITORY_POLICY_PATH} approves ${policy.approvedPipelineIds.join(", ")}; ${subject.pipelineId} is not approved for this repository`,
    );
  }
  if (
    policy.maxWriteScope !== undefined &&
    WRITE_SCOPE_RANK[subject.writeScope] > WRITE_SCOPE_RANK[policy.maxWriteScope]
  ) {
    refusals.push(
      `${REPOSITORY_POLICY_PATH} caps the write scope at ${policy.maxWriteScope}; this run resolves to ${subject.writeScope}`,
    );
  }
  if (policy.commitMode === "never" && subject.commitPolicy === "allow") {
    refusals.push(`${REPOSITORY_POLICY_PATH} forbids commits; this run resolves commit authority to allow`);
  }
  if (policy.allowedVerifiers) {
    subject.verification
      .filter((command) => !policy.allowedVerifiers?.includes(command))
      .forEach((command) => refusals.push(
        `${REPOSITORY_POLICY_PATH} does not allow the verification operation ${command}`,
      ));
  }
  if (policy.protectedPaths) {
    policy.protectedPaths
      .filter((candidate) => !subject.protectedPaths.includes(candidate))
      .forEach((candidate) => refusals.push(
        `${REPOSITORY_POLICY_PATH} protects ${candidate}; this run does not declare it as protected`,
      ));
  }
  if (policy.requireHumanGate === true && subject.humanGateCount === 0) {
    refusals.push(`${REPOSITORY_POLICY_PATH} requires at least one human gate; this run declares none`);
  }
  return refusals;
};

export const narrowLocalWriteScope = (
  policy: RepositoryPolicy | undefined,
  local: WorkspaceWriteScope,
): WorkspaceWriteScope => {
  if (policy?.maxWriteScope === undefined) return local;
  return WRITE_SCOPE_RANK[local] > WRITE_SCOPE_RANK[policy.maxWriteScope]
    ? policy.maxWriteScope
    : local;
};

export const narrowLocalCommitMode = (
  policy: RepositoryPolicy | undefined,
  local: "never" | "allow",
): "never" | "allow" => (policy?.commitMode === "never" ? "never" : local);
