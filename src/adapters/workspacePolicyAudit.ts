import { createHash } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import * as path from "node:path";

import type { WorkspaceWriteScope, SendRequest } from "./types";
import {
  assertWorkspacePathAllowed,
  isRestrictedWorkspacePath,
  normalizeWorkspaceRelativePath,
} from "../browser/mutationPolicy";
import { runProcess } from "../orchestrator/commandRunner";
import { configuredProcessEnvironment, gitProcessEnvironment } from "../process/safeEnvironment";
import { sha256FilePath } from "../security/fileHash";

export type ResolvedWorkspaceWritePolicy = {
  writeScope: WorkspaceWriteScope;
  allowedPaths: string[];
  readOnly: boolean;
};

export type WorkspacePolicyAuditSnapshot = {
  isGitRepository: boolean;
  head: string;
  /**
   * EX-A5-R13. The root every entry name is relative to. Porcelain status names paths from the
   * repository root whatever directory Git ran in, so a nested working directory is not the root
   * those names resolve against and cannot be used to read, hash or scope them.
   */
  repositoryRoot: string;
  entries: Record<string, string>;
};

const TASK_PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\s`"'<>]+|\/[^\s`"'<>]+|(?:\.\.?[\\/])?(?:[\p{L}\p{M}\p{N}_@.\-]+[\\/])+[\p{L}\p{M}\p{N}_@.\-]+|(?:\.\.?[\\/])?[\p{L}\p{M}\p{N}_@.\-]+\.[A-Za-z0-9.]+)/gu;
const MAX_AUDIT_PATHS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

const normalizePolicyPath = (value: string): string | undefined => {
  const trimmed = value.trim().replace(/[),.;:]+$/u, "");
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return undefined;
  try {
    const normalized = normalizeWorkspaceRelativePath(trimmed);
    if (normalized === "." || isRestrictedWorkspacePath(normalized)) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
};

const uniquePaths = (values: readonly string[]): string[] => {
  const paths: string[] = [];
  for (const value of values) {
    const normalized = normalizePolicyPath(value);
    if (normalized && !paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
};

export const extractExplicitWorkspacePaths = (
  task: string,
  workspaceRoot: string,
  maxPaths = 64,
): string[] => {
  const root = path.resolve(workspaceRoot);
  const results: string[] = [];
  for (const match of task.match(TASK_PATH_PATTERN) ?? []) {
    const raw = match.trim().replace(/[),.;:]+$/u, "");
    if (!raw || /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) continue;
    let relative = raw;
    if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/u.test(raw)) {
      const absolute = path.resolve(raw);
      const candidate = path.relative(root, absolute);
      if (candidate === ".." || candidate.startsWith(`..${path.sep}`) || path.isAbsolute(candidate)) continue;
      relative = candidate.split(path.sep).join("/");
    }
    const normalized = normalizePolicyPath(relative);
    if (!normalized || results.includes(normalized)) continue;
    results.push(normalized);
    if (results.length >= Math.max(1, maxPaths)) break;
  }
  return results;
};

export const resolveWorkspaceWritePolicy = (input: {
  task: string;
  workspaceRoot: string;
  writeScope?: WorkspaceWriteScope;
  allowedPaths?: readonly string[];
  readOnly?: boolean;
  defaultScope: WorkspaceWriteScope;
}): ResolvedWorkspaceWritePolicy => {
  if (input.writeScope === "readOnly" || (input.readOnly === true && input.writeScope === undefined)) {
    return { writeScope: "readOnly", allowedPaths: [], readOnly: true };
  }
  const writeScope = input.writeScope ?? input.defaultScope;
  if (writeScope === "workspace") {
    return { writeScope, allowedPaths: ["."], readOnly: input.readOnly === true };
  }
  const configured = uniquePaths(input.allowedPaths ?? []);
  if (writeScope === "configured") {
    if (configured.length === 0) {
      throw new Error("Configured workspace write scope requires at least one allowed path");
    }
    return { writeScope, allowedPaths: configured, readOnly: input.readOnly === true };
  }
  if (writeScope === "task") {
    const taskPaths = configured.length > 0
      ? configured
      : extractExplicitWorkspacePaths(input.task, input.workspaceRoot);
    if (taskPaths.length === 0) {
      throw new Error("Task-scoped execution requires an explicit file or directory path in the task or controller policy");
    }
    return { writeScope, allowedPaths: taskPaths, readOnly: input.readOnly === true };
  }
  throw new Error(`Unsupported workspace write scope: ${String(writeScope)}`);
};

const auditProcessOptions = (workingDirectory: string, signal?: AbortSignal) => ({
  cwd: workingDirectory,
  timeoutMs: 30_000,
  maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
  ...(signal === undefined ? {} : { signal }),
  environment: gitProcessEnvironment(workingDirectory, configuredProcessEnvironment(workingDirectory)),
});

const parseStatusPaths = (value: string): string[] => {
  const fields = value.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== " ") throw new Error("Git returned invalid porcelain status output");
    const status = field.slice(0, 2);
    const rawPath = field.slice(3);
    if (rawPath) paths.push(rawPath);
    if (/[RC]/u.test(status)) {
      const second = fields[index + 1];
      if (!second) throw new Error("Git returned an incomplete rename/copy status entry");
      paths.push(second);
      index += 1;
    }
  }
  return [...new Set(paths.map((entry) => normalizeWorkspaceRelativePath(entry)))].sort();
};

const hashFile = (absolute: string): Promise<string> => sha256FilePath(absolute);

const filesystemFingerprint = async (workingDirectory: string, relative: string): Promise<string> => {
  const absolute = path.resolve(workingDirectory, relative);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return `symlink:${await readlink(absolute)}`;
    if (info.isFile()) return `file:${String(info.mode)}:${String(info.size)}:${await hashFile(absolute)}`;
    if (info.isDirectory()) return `directory:${String(info.mode)}`;
    return `other:${String(info.mode)}:${String(info.size)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
};

/**
 * The index is read once per capture, not once per dirty path. A repository whose untracked tree
 * is large made this the difference between two `git` processes per turn and thousands of them.
 */
const auditEntries = async (
  repositoryRoot: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, string>> => {
  const entries: Record<string, string> = {};
  if (paths.length === 0) return entries;
  // EX-A5-R13. Read from the repository root, so the listing's names are the same
  // repository-root-relative names the status output gave and the two can be matched at all.
  const result = await runProcess("git", ["ls-files", "-s", "-z"], auditProcessOptions(repositoryRoot, signal));
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.cancelled
    || !result.cleanupConfirmed
    || result.stdoutTruncated
  ) {
    throw new Error(result.stderr || "Unable to inspect Git index state");
  }
  const wanted = new Set(paths);
  const matched = new Map<string, string[]>();
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Git returned invalid index listing output");
    let key: string | undefined = record.slice(separator + 1);
    while (key !== undefined) {
      const bucket = matched.get(key);
      if (bucket) bucket.push(record);
      else if (wanted.has(key)) matched.set(key, [record]);
      const slash = key.lastIndexOf("/");
      key = slash < 0 ? undefined : key.slice(0, slash);
    }
  }
  for (const relative of paths) {
    entries[relative] = createHash("sha256")
      .update(await filesystemFingerprint(repositoryRoot, relative))
      .update(createHash("sha256").update((matched.get(relative) ?? []).join("\0")).digest("hex"))
      .digest("hex");
  }
  return entries;
};

export const captureWorkspacePolicyAudit = async (
  requestData: SendRequest,
  signal?: AbortSignal,
): Promise<WorkspacePolicyAuditSnapshot> => {
  const options = auditProcessOptions(requestData.workingDirectory, signal);
  const probe = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], options);
  // A probe that never answered is not evidence of anything. Only a probe that ran to completion
  // and said no may be recorded as "not a repository"; an interrupted one refuses.
  if (probe.timedOut || probe.cancelled || !probe.cleanupConfirmed) {
    throw new Error(probe.stderr || "Unable to determine whether the workspace is a Git repository");
  }
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    return { isGitRepository: false, head: "", repositoryRoot: "", entries: {} };
  }
  const rootResult = await runProcess("git", ["rev-parse", "--show-toplevel"], options);
  if (
    rootResult.exitCode !== 0
    || rootResult.timedOut
    || rootResult.cancelled
    || !rootResult.cleanupConfirmed
    || !rootResult.stdout.trim()
  ) {
    throw new Error(rootResult.stderr || "Unable to locate the workspace Git repository root");
  }
  const repositoryRoot = path.resolve(rootResult.stdout.trim());
  const headResult = await runProcess("git", ["rev-parse", "HEAD"], options);
  if (headResult.exitCode !== 0 || headResult.timedOut || headResult.cancelled || !headResult.cleanupConfirmed) {
    throw new Error(headResult.stderr || "Unable to capture Git HEAD");
  }
  const status = await runProcess("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options);
  if (status.exitCode !== 0 || status.timedOut || status.cancelled || !status.cleanupConfirmed) {
    throw new Error(status.stderr || "Unable to capture Git workspace state");
  }
  const paths = parseStatusPaths(status.stdout);
  if (paths.length > MAX_AUDIT_PATHS) throw new Error(`Workspace policy audit exceeded ${String(MAX_AUDIT_PATHS)} dirty paths`);
  return {
    isGitRepository: true,
    head: headResult.stdout.trim(),
    repositoryRoot,
    entries: await auditEntries(repositoryRoot, paths, signal),
  };
};

export const assertWorkspacePolicyAudit = async (
  requestData: SendRequest,
  before: WorkspacePolicyAuditSnapshot,
  signal?: AbortSignal,
): Promise<void> => {
  const policy = requestData.workspacePolicy;
  if (!policy) return;
  const bounded = policy.writeScope === "task" || policy.writeScope === "configured" || policy.writeScope === "readOnly";
  if (policy.automated === true && bounded && !before.isGitRepository) {
    throw new Error("Task-scoped autonomous local-agent execution requires a Git worktree for authoritative post-turn validation");
  }
  const after = await captureWorkspacePolicyAudit(requestData, signal);
  if (before.isGitRepository !== after.isGitRepository) throw new Error("Workspace repository identity changed during the agent turn");
  if (before.isGitRepository && before.head !== after.head) {
    throw new Error("Git HEAD changed during a no-commit agent turn");
  }
  if (before.isGitRepository && before.repositoryRoot !== after.repositoryRoot) {
    throw new Error("Workspace repository identity changed during the agent turn");
  }
  const paths = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])]
    .filter((relative) => before.entries[relative] !== after.entries[relative])
    .sort();
  if (policy.readOnly && paths.length > 0) {
    throw new Error(`Read-only participant changed workspace paths: ${paths.slice(0, 20).join(", ")}`);
  }
  // EX-A5-R13. Entry names are repository-root-relative; a participant's scope is its own
  // working directory. Each changed path is resolved against the root it was named from and then
  // renamed for the directory the policy is written in, and a change that lands outside that
  // directory is refused rather than measured against a name it does not have.
  // `rev-parse --show-toplevel` answers with the resolved path, so the working directory has to be
  // resolved the same way or a symlinked temporary directory reads as another tree entirely.
  const workspaceRoot = await realpath(requestData.workingDirectory)
    .catch(() => path.resolve(requestData.workingDirectory));
  for (const relative of paths) {
    const absolute = path.resolve(after.repositoryRoot || workspaceRoot, relative);
    const withinWorkspace = path.relative(workspaceRoot, absolute);
    if (
      withinWorkspace === ""
      || withinWorkspace === ".."
      || withinWorkspace.startsWith(`..${path.sep}`)
      || path.isAbsolute(withinWorkspace)
    ) {
      throw new Error(`Participant changed a workspace path outside its working directory: ${relative}`);
    }
    await assertWorkspacePathAllowed(requestData.workingDirectory, withinWorkspace.split(path.sep).join("/"), {
      ...(policy.allowedPaths === undefined ? {} : { allowedPaths: policy.allowedPaths }),
      ...(policy.restrictedPaths === undefined
        ? {}
        : { restrictedPaths: policy.restrictedPaths }),
      scopeMode: policy.writeScope === "workspace" ? "workspace" : "bounded",
      commitMode: policy.commitMode,
      readOnly: policy.readOnly,
    });
  }
};
