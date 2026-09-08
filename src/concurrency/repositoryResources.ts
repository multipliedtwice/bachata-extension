import { realpath } from "node:fs/promises";
import { gitProcessEnvironment } from "../process/safeEnvironment";
import * as path from "node:path";

import { runProcess } from "../orchestrator/commandRunner";
import { resourceKey, ResourceClaim } from "./resourceBroker";

export type WorkingResourceIdentity = {
  canonicalWorkingDirectory: string;
  repositoryIdentity?: string;
  repositoryRoot?: string;
};

const canonicalPath = async (value: string): Promise<string> => {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return resolved;
    }
    throw error;
  }
};

const gitValue = async (cwd: string, args: string[]): Promise<string | undefined> => {
  try {
    const result = await runProcess("git", args, {
      cwd,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
      environment: gitProcessEnvironment(cwd),
    });
    if (result.cancelled || result.timedOut || result.exitCode !== 0) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

export const mainWorktreeRootFromCommonDir = (
  commonDirectory: string,
): string | undefined => {
  const normalized = commonDirectory.replaceAll("\\", "/").replace(/\/+$/u, "");
  const segments = normalized.split("/");
  if (segments.length < 2 || segments.at(-1) !== ".git") return undefined;
  const root = segments.slice(0, -1).join("/");
  return root.length === 0 ? "/" : root;
};

export const resolveWorkingResourceIdentity = async (
  workingDirectory: string,
): Promise<WorkingResourceIdentity> => {
  const canonicalWorkingDirectory = await canonicalPath(workingDirectory);
  const [root, common] = await Promise.all([
    gitValue(canonicalWorkingDirectory, ["rev-parse", "--show-toplevel"]),
    gitValue(canonicalWorkingDirectory, ["rev-parse", "--git-common-dir"]),
  ]);
  if (!root || !common) {
    return { canonicalWorkingDirectory };
  }
  const repositoryRoot = await canonicalPath(path.resolve(canonicalWorkingDirectory, root));
  const repositoryIdentity = await canonicalPath(path.resolve(canonicalWorkingDirectory, common));
  return { canonicalWorkingDirectory, repositoryIdentity, repositoryRoot };
};

export const repositoryExecutionClaims = (
  identity: WorkingResourceIdentity,
  options: {
    managedTask: boolean;
    repositoryCapacity: number;
  },
): ResourceClaim[] => {
  const capacity = Math.max(1, Math.trunc(options.repositoryCapacity));
  if (!identity.repositoryIdentity) {
    return [{
      key: resourceKey("working-directory", identity.canonicalWorkingDirectory),
      kind: "physical",
    }];
  }
  const claims: ResourceClaim[] = [{
    key: resourceKey("repository-execution", identity.repositoryIdentity),
    units: options.managedTask ? 1 : capacity,
    capacity,
    kind: "physical",
  }];
  if (options.managedTask) {
    claims.push({
      key: resourceKey("managed-worktree", identity.canonicalWorkingDirectory),
      kind: "physical",
    });
  }
  return claims;
};

export const repositoryCheckClaim = (
  identity: WorkingResourceIdentity,
): ResourceClaim => ({
  key: resourceKey(
    "repository-check",
    identity.repositoryIdentity ?? identity.canonicalWorkingDirectory,
  ),
  kind: "physical",
});

export const gitAdministrationClaim = (repositoryIdentity: string): ResourceClaim => ({
  key: resourceKey("git-administration", repositoryIdentity),
  kind: "physical",
});
