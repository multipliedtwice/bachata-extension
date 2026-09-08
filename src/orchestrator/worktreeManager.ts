import { managedCommitMode, shouldCreateManagedCommit, type ManagedCommitMode } from "./managedCommitPolicy";
import { randomBytes } from "node:crypto";
import { chmod, constants, copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { isPathInsideRoot } from "../process/pathBoundary";
import { parsePorcelainStatusRecords } from "../readiness/gitStatus";

import { gitAdministrationClaim } from "../concurrency/repositoryResources";
import { ResourceBroker } from "../concurrency/resourceBroker";
import { gitProcessEnvironment } from "../process/safeEnvironment";
import { evaluateGitVersionSupport } from "../process/gitVersionSupport";
import { runProcess } from "./commandRunner";
import { legacyStorageIdentity, taskStorageIdentity } from "./identity";
import { canonicalizePath, isPathInside } from "../pipeline/catalogStorage";
import {
  parsePatchFiles,
  selectPatch,
  selectionIsEmpty,
  type PatchFileSummary,
  type PatchSelection,
} from "./patchSelection";

export { taskStorageIdentity } from "./identity";

export class GitCommandError extends Error {
  readonly command: string[];
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly cleanupConfirmed: boolean;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string[], result: Awaited<ReturnType<typeof runProcess>>) {
    const rendered = command.map((value) => JSON.stringify(value)).join(" ");
    super([`Command failed: ${rendered}`, result.stderr, result.stdout].filter(Boolean).join("\n"));
    this.name = "GitCommandError";
    this.command = command;
    this.exitCode = result.exitCode;
    this.timedOut = result.timedOut;
    this.cancelled = result.cancelled;
    this.cleanupConfirmed = result.cleanupConfirmed;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

const unconfirmedGitErrors = (error: unknown): GitCommandError[] => {
  if (error instanceof GitCommandError) {
    return error.cleanupConfirmed ? [] : [error];
  }
  if (error instanceof AggregateError) {
    return error.errors.flatMap(unconfirmedGitErrors);
  }
  if (error instanceof Error && error.cause) {
    return unconfirmedGitErrors(error.cause);
  }
  return [];
};

const executeGit = async (
  executable: string,
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
  trimOutput = true,
  environment?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> => {
  const result = await runProcess(executable, args, {
    cwd,
    timeoutMs,
    maxOutputBytes: 2_097_152,
    environment: gitProcessEnvironment(cwd, environment),
    ...(signal ? { signal } : {}),
  });
  if (result.cancelled || result.timedOut || result.exitCode !== 0) {
    throw new GitCommandError([executable, ...args], result);
  }
  // EX-A5-R02. Everything read through here is machine-readable: NUL-separated inventories,
  // object ids, porcelain status. A bound that dropped part of one leaves a caller parsing a
  // list that silently omits whatever came after the limit — and the last surviving entry is a
  // fragment of a name that matches nothing. There is no safe partial answer, so a truncated
  // read is a failed read.
  if (result.stdoutTruncated) {
    const { exitCode: _ignoredExitCode, ...withoutExitCode } = result;
    throw new GitCommandError([executable, ...args], {
      ...withoutExitCode,
      stderr: [
        result.stderr,
        `Git output exceeded ${String(2_097_152)} bytes and was truncated, so it cannot be parsed`,
      ].filter(Boolean).join("\n"),
    });
  }
  return trimOutput ? result.stdout.trimEnd() : result.stdout;
};

const confirmedFallback = async <T>(
  operation: Promise<T>,
  fallback: T,
): Promise<T> => {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof GitCommandError && error.cleanupConfirmed) {
      return fallback;
    }
    throw error;
  }
};

const uniqueNulPaths = (...values: string[]): string[] =>
  Array.from(new Set(values.flatMap((value) => value.split("\0")).filter(Boolean))).sort();

const contained = (root: string, candidate: string): boolean =>
  isPathInsideRoot(root, candidate);

export type RunWorktree = {
  repositoryRoot: string;
  baselineCommit: string;
  inputTree?: string;
  sealedInputPaths?: string[];
  integrationBranch: string;
  integrationWorktree: string;
  integrationTree?: string;
  commitMode: ManagedCommitMode;
};

/**
 * Dependency directories the worktree shares with the live repository instead of owning. They
 * are links out of the worktree, so a command that writes through one writes into the person's
 * own checkout: those bytes are outside the run's isolation, absent from its changed files, its
 * patch and Apply, and not undone by abandoning the run. Named here so a run can record the
 * exemption rather than claim an isolation it does not have.
 */
export type SharedDependencies = { sharedDependencies?: string[] };

export type TaskWorktree = SharedDependencies & {
  taskId: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
  baseTree?: string;
  commitMode: ManagedCommitMode;
};

export type ValidationWorktree = SharedDependencies & {
  worktreePath: string;
  snapshotCommit: string;
};

export type GitWorktreeState = {
  head: string;
  branch: string;
  indexTree: string;
  status: string;
};

export type WorktreeManager = {
  repositoryIdentity: (workspaceRoot: string) => Promise<string>;
  preflightRun: (
    workspaceRoot: string,
    allowedDirtyPaths?: string[],
    sealedInputPaths?: string[],
  ) => Promise<void>;
  dirtyRepositoryPaths: (workspaceRoot: string) => Promise<string[]>;
  prepareRun: (
    workspaceRoot: string,
    runId: string,
    allowedDirtyPaths?: string[],
    commitMode?: ManagedCommitMode,
    sealedInputPaths?: string[],
  ) => Promise<RunWorktree>;
  restoreRun: (run: RunWorktree) => Promise<void>;
  prepareTask: (run: RunWorktree, taskId: string) => Promise<TaskWorktree>;
  prepareValidation: (
    run: RunWorktree,
    sourceWorktree: string,
    label: string,
  ) => Promise<ValidationWorktree>;
  prepareExportValidation: (
    run: RunWorktree,
    label: string,
    selection?: PatchSelection,
  ) => Promise<ValidationWorktree>;
  removeValidation: (run: RunWorktree, validation: ValidationWorktree) => Promise<void>;
  worktreeState: (worktreePath: string) => Promise<GitWorktreeState>;
  changedFiles: (task: TaskWorktree) => Promise<string[]>;
  taskPatch: (task: TaskWorktree, maxBytes?: number) => Promise<string>;
  normalizeTaskNoCommit: (task: TaskWorktree) => Promise<void>;
  commitTask: (task: TaskWorktree, title: string) => Promise<string | undefined>;
  integrateTask: (run: RunWorktree, task: TaskWorktree, title: string) => Promise<string>;
  commitIntegration: (run: RunWorktree, message: string) => Promise<string | undefined>;
  integrationCommit: (run: RunWorktree) => Promise<string>;
  resetIntegration: (run: RunWorktree, commit: string) => Promise<void>;
  integrationStatus: (run: RunWorktree) => Promise<string>;
  removeTask: (run: RunWorktree, task: TaskWorktree, deleteBranch?: boolean) => Promise<void>;
  cleanupRun: (run: RunWorktree) => Promise<void>;
  abandonRun: (run: RunWorktree) => Promise<void>;
  runPatch: (run: RunWorktree, selection?: PatchSelection) => Promise<string>;
  runChangedPaths: (run: RunWorktree) => Promise<string[]>;
  /**
   * EX-A5-R01. The commit the receiving branch is on right now. Evidence is bound to it, and a
   * branch that moved since the checks ran is a different composition from the one they saw.
   */
  targetHead: (run: RunWorktree) => Promise<string>;
  runPatchFiles: (run: RunWorktree) => Promise<PatchFileSummary[]>;
  applyRun: (run: RunWorktree, selection?: PatchSelection) => Promise<ApplyRunResult>;
};

export type ApplyRunResult = {
  applied: boolean;
  targetBranch: string;
  stagedFiles: string[];
  conflicts: string[];
  reason?: string;
};

const parseGitStatus = parsePorcelainStatusRecords;

export const MAXIMUM_RUN_PATCH_BYTES = 64 * 1_048_576;

export const createWorktreeManager = (
  storageRoot: string,
  options: {
    resourceBroker?: ResourceBroker;
    lockTimeoutMs?: () => number;
    signal?: () => AbortSignal | undefined;
    gitExecutable?: string;
    gitArgumentsPrefix?: string[];
  } = {},
): WorktreeManager => {
  const gitExecutable = options.gitExecutable ?? "git";
  const gitArgumentsPrefix = options.gitArgumentsPrefix ?? [];
  let gitVersionConfirmed = false;
  const runsRoot = path.resolve(storageRoot, "orchestration", "runs");
  const git = (
    cwd: string,
    args: string[],
    timeoutMs = 120_000,
    trimOutput = true,
    environment?: NodeJS.ProcessEnv,
    signal = options.signal?.(),
  ): Promise<string> => executeGit(
    gitExecutable,
    cwd,
    [...gitArgumentsPrefix, ...args],
    timeoutMs,
    trimOutput,
    environment,
    signal,
  );

  const cleanupGit = (
    cwd: string,
    args: string[],
    timeoutMs = 120_000,
    trimOutput = true,
    environment?: NodeJS.ProcessEnv,
  ): Promise<string> => executeGit(
    gitExecutable,
    cwd,
    [...gitArgumentsPrefix, ...args],
    timeoutMs,
    trimOutput,
    environment,
  );


  const runRoot = (run: RunWorktree): string => {
    if (!run.integrationBranch.startsWith("bachata/integration/")) {
      throw new Error("Invalid integration branch namespace");
    }
    const value = path.dirname(path.resolve(run.integrationWorktree));
    if (
      path.basename(path.resolve(run.integrationWorktree)) !== "integration" ||
      !contained(runsRoot, value) ||
      value === runsRoot
    ) {
      throw new Error("Integration worktree is outside Bachata storage");
    }
    return value;
  };

  const sealedInputRef = (run: RunWorktree): string => {
    runRoot(run);
    const runPart = run.integrationBranch.slice("bachata/integration/".length);
    if (!/^[A-Za-z0-9._-]+$/u.test(runPart)) {
      throw new Error("Invalid sealed input ref namespace");
    }
    return `refs/bachata/input/${runPart}`;
  };

  const integrationStateRef = (run: RunWorktree): string => {
    runRoot(run);
    const runPart = run.integrationBranch.slice("bachata/integration/".length);
    if (!/^[A-Za-z0-9._-]+$/u.test(runPart)) {
      throw new Error("Invalid integration state ref namespace");
    }
    return `refs/bachata/state/${runPart}`;
  };

  const persistIntegrationTree = async (run: RunWorktree): Promise<string> => {
    const tree = await git(run.integrationWorktree, ["write-tree"]);
    await git(run.repositoryRoot, ["update-ref", integrationStateRef(run), tree]);
    return tree;
  };

  const assertTaskOwnership = (run: RunWorktree, task: TaskWorktree): void => {
    const root = runRoot(run);
    const taskRoot = path.resolve(root, "tasks");
    const worktreePath = path.resolve(task.worktreePath);
    const taskParts = new Set([
      legacyStorageIdentity(task.taskId),
      taskStorageIdentity(task.taskId),
    ]);
    const taskPart = path.basename(worktreePath);
    const runPart = run.integrationBranch.slice("bachata/integration/".length);
    if (
      path.dirname(worktreePath) !== taskRoot ||
      !taskParts.has(taskPart)
    ) {
      throw new Error("Task worktree is outside the Bachata run directory");
    }
    if (task.branch !== `bachata/task/${runPart}/${taskPart}`) {
      throw new Error("Invalid task branch ownership");
    }
  };

  const assertTaskLineage = async (task: TaskWorktree): Promise<string> => {
    const branch = await confirmedFallback(git(task.worktreePath, ["symbolic-ref", "-q", "--short", "HEAD"]), "DETACHED");
    if (branch !== task.branch) {
      throw new Error(`Task ${task.taskId} left its Bachata branch`);
    }
    try {
      await git(task.worktreePath, ["merge-base", "--is-ancestor", task.baseCommit, "HEAD"]);
    } catch (error) {
      if (error instanceof GitCommandError && error.cleanupConfirmed) {
        throw new Error(`Task ${task.taskId} rewrote history outside its Bachata base commit`);
      }
      throw error;
    }
    return git(task.worktreePath, ["rev-parse", "HEAD"]);
  };

  const taskBaseline = (task: TaskWorktree): string => task.baseTree ?? task.baseCommit;

  const repositoryIdentityUsing = async (
    workspaceRoot: string,
    command = git,
  ): Promise<string> => {
    const commonDirectory = await command(workspaceRoot, ["rev-parse", "--git-common-dir"]);
    return realpath(path.resolve(workspaceRoot, commonDirectory));
  };

  const repositoryIdentity: WorktreeManager["repositoryIdentity"] = (workspaceRoot) =>
    repositoryIdentityUsing(workspaceRoot);

  const worktreeState: WorktreeManager["worktreeState"] = async (worktreePath) => {
    const [head, branch] = await Promise.all([
      git(worktreePath, ["rev-parse", "HEAD"]),
      confirmedFallback(git(worktreePath, ["symbolic-ref", "-q", "--short", "HEAD"]), "DETACHED"),
    ]);
    const indexTree = await git(worktreePath, ["write-tree"]);
    const status = await git(
      worktreePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      120_000,
      false,
    );
    return { head, branch, indexTree, status };
  };

  const worktreePaths = async (
    repositoryRoot: string,
    command = git,
  ): Promise<string[]> => {
    const listing = await command(repositoryRoot, ["worktree", "list", "--porcelain"], 120_000, false);
    return Promise.all(
      listing
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => canonicalizePath(line.slice("worktree ".length))),
    );
  };

  const removeWorktreeIfPresent = async (
    repositoryRoot: string,
    worktreePath: string,
    command = git,
  ): Promise<void> => {
    const resolved = await canonicalizePath(worktreePath);
    if ((await worktreePaths(repositoryRoot, command)).includes(resolved)) {
      await command(repositoryRoot, ["worktree", "remove", "--force", resolved]);
    }
    await rm(resolved, { recursive: true, force: true });
    await command(repositoryRoot, ["worktree", "prune"]);
    if ((await worktreePaths(repositoryRoot, command)).includes(resolved)) {
      throw new Error(`Git worktree cleanup was not confirmed: ${resolved}`);
    }
  };

  const branchExists = async (
    repositoryRoot: string,
    branch: string,
    command = git,
  ): Promise<boolean> => {
    const listing = await command(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${branch}`,
    ]);
    return listing.split(/\r?\n/u).includes(branch);
  };

  const deleteBranchIfPresent = async (
    repositoryRoot: string,
    branch: string,
    command = git,
  ): Promise<void> => {
    if (await branchExists(repositoryRoot, branch, command)) {
      await command(repositoryRoot, ["branch", "-D", branch]);
    }
    if (await branchExists(repositoryRoot, branch, command)) {
      throw new Error(`Git branch cleanup was not confirmed: ${branch}`);
    }
  };

  const assertSupportedGitVersion = async (cwd: string): Promise<void> => {
    if (gitVersionConfirmed) {
      return;
    }
    const reported = await git(cwd, ["--version"]);
    const support = evaluateGitVersionSupport(reported);
    if (!support.supported) {
      throw new Error(support.requirementText);
    }
    gitVersionConfirmed = true;
  };

  const writeDiffPatch = async (
    cwd: string,
    diffArguments: string[],
    patchPath: string,
  ): Promise<boolean> => {
    await rm(patchPath, { force: true });
    await git(cwd, ["diff", `--output=${patchPath}`, ...diffArguments], 300_000, false);
    return (await stat(patchPath)).size > 0;
  };

  const repositoryPreflight = async (
    workspaceRoot: string,
    allowedDirtyPaths: string[] = [],
    sealedInputPaths: string[] = [],
  ): Promise<{ repositoryRoot: string; baselineCommit: string; sealedInput: string[] }> => {
    await assertSupportedGitVersion(workspaceRoot);
    const repositoryRootValue = await git(workspaceRoot, ["rev-parse", "--show-toplevel"]);
    const repositoryRoot = await canonicalizePath(repositoryRootValue);
    const normalizedAllowedDirtyPaths = Array.isArray(allowedDirtyPaths)
      ? allowedDirtyPaths
      : [];
    const allowedDirectories = await Promise.all(
      normalizedAllowedDirtyPaths.map(async (value) => {
        const canonical = await canonicalizePath(value);
        if (!isPathInside(repositoryRoot, canonical)) {
          throw new Error(
            `Allowed dirty path is outside the Git repository: ${value}`,
          );
        }
        return canonical;
      }),
    );
    const status = await git(
      repositoryRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      120_000,
      false,
    );
    const entries = parseGitStatus(status);
    const sealed = new Set(
      sealedInputPaths.map((value) => value.replaceAll("\\", "/").replace(/^\.\//u, "")),
    );
    const disallowed: string[] = [];
    const sealedInput: string[] = [];
    for (const entry of entries) {
      if (sealed.size > 0 && entry.paths.every((statusPath) => sealed.has(statusPath))) {
        sealedInput.push(...entry.paths);
        continue;
      }
      let allowed = allowedDirectories.length > 0;
      for (const statusPath of entry.paths) {
        const absolute = await canonicalizePath(path.resolve(repositoryRoot, statusPath));
        if (!allowedDirectories.some((directory) => isPathInside(directory, absolute))) {
          allowed = false;
        }
      }
      if (!allowed) {
        disallowed.push(...entry.paths);
      }
    }
    if (disallowed.length > 0) {
      const paths = Array.from(new Set(disallowed)).sort().join(", ");
      throw new Error(
        `The repository must be clean before starting TODO orchestration. Dirty paths: ${paths}`,
      );
    }
    const unknownSealed = Array.from(sealed)
      .filter((value) => !sealedInput.includes(value))
      .sort();
    if (unknownSealed.length > 0) {
      throw new Error(
        `Bachata refuses to seal paths that are not changed in the working tree: ${unknownSealed.join(", ")}`,
      );
    }
    const baselineCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    return {
      repositoryRoot,
      baselineCommit,
      sealedInput: Array.from(new Set(sealedInput)).sort(),
    };
  };

  const dirtyRepositoryPaths: WorktreeManager["dirtyRepositoryPaths"] = async (workspaceRoot) => {
    await assertSupportedGitVersion(workspaceRoot);
    const repositoryRoot = await canonicalizePath(
      await git(workspaceRoot, ["rev-parse", "--show-toplevel"]),
    );
    const status = await git(
      repositoryRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      120_000,
      false,
    );
    return Array.from(new Set(parseGitStatus(status).flatMap((entry) => entry.paths))).sort();
  };

  const preflightRun: WorktreeManager["preflightRun"] = async (
    workspaceRoot,
    allowedDirtyPaths = [],
    sealedInputPaths = [],
  ) => {
    await repositoryPreflight(workspaceRoot, allowedDirtyPaths, sealedInputPaths);
  };

  const sealWorkingTreeInput = async (
    run: RunWorktree,
    sealedPaths: string[],
  ): Promise<string> => {
    const root = runRoot(run);
    const patchPath = path.join(root, `sealed-input-${randomBytes(8).toString("hex")}.patch`);
    try {
      const hasPatch = await writeDiffPatch(
        run.repositoryRoot,
        ["--binary", "--full-index", "HEAD", "--", ...sealedPaths],
        patchPath,
      );
      if (hasPatch) {
        await git(
          run.integrationWorktree,
          ["apply", "--index", "--whitespace=nowarn", patchPath],
          300_000,
          false,
        );
      }
    } finally {
      await rm(patchPath, { force: true }).catch(() => undefined);
    }
    const untracked = uniqueNulPaths(
      await confirmedFallback(
        git(
          run.repositoryRoot,
          ["ls-files", "--others", "--exclude-standard", "-z", "--", ...sealedPaths],
          120_000,
          false,
        ),
        "",
      ),
    );
    for (const relative of untracked) {
      const source = path.resolve(run.repositoryRoot, relative);
      const target = path.resolve(run.integrationWorktree, relative);
      if (!contained(run.repositoryRoot, source) || !contained(run.integrationWorktree, target)) {
        throw new Error(`Sealed input path escapes the run worktree: ${relative}`);
      }
      const symbolicLinkError = () => new Error(
        `Bachata refuses to seal a symbolic link as run input: ${relative}. Seal the file it points at, or commit the link.`,
      );
      const before = await lstat(source, { bigint: true });
      if (before.isSymbolicLink()) throw symbolicLinkError();
      if (!before.isFile()) {
        throw new Error(`Bachata refuses to seal a path that is not a regular file: ${relative}`);
      }
      const canonicalSource = await realpath(source);
      if (!contained(run.repositoryRoot, canonicalSource)) throw symbolicLinkError();
      const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP" || code === "EMLINK" || code === "ENOTDIR") {
          throw symbolicLinkError();
        }
        throw error;
      });
      try {
        const details = await handle.stat({ bigint: true });
        const current = await lstat(source, { bigint: true });
        if (current.isSymbolicLink()) throw symbolicLinkError();
        if (!details.isFile() || !current.isFile()) {
          throw new Error(`Bachata refuses to seal a path that is not a regular file: ${relative}`);
        }
        if (before.dev !== details.dev || before.ino !== details.ino
          || current.dev !== details.dev || current.ino !== details.ino
          || await realpath(source) !== canonicalSource) {
          throw new Error(`Bachata refuses to seal a path that changed while it was opened: ${relative}`);
        }
        const contents = await handle.readFile();
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents, { flag: "wx", mode: Number(details.mode & 0o777n) });
      } finally {
        await handle.close();
      }
    }
    await git(run.integrationWorktree, ["add", "--all"]);
    const tree = await git(run.integrationWorktree, ["write-tree"]);
    await git(run.repositoryRoot, ["update-ref", sealedInputRef(run), tree]);
    return tree;
  };

  const prepareRun: WorktreeManager["prepareRun"] = async (
    workspaceRoot,
    runId,
    allowedDirtyPaths = [],
    requestedCommitMode = "never",
    sealedInputPaths = [],
  ) => {
    const { repositoryRoot, baselineCommit, sealedInput } = await repositoryPreflight(
      workspaceRoot,
      allowedDirtyPaths,
      sealedInputPaths,
    );
    const root = path.join(runsRoot, taskStorageIdentity(runId));
    const integrationWorktree = path.join(root, "integration");
    const integrationBranch = `bachata/integration/${taskStorageIdentity(runId)}`;
    await mkdir(root, { recursive: true });
    try {
      await removeWorktreeIfPresent(repositoryRoot, integrationWorktree);
      await deleteBranchIfPresent(repositoryRoot, integrationBranch);
      await git(repositoryRoot, [
        "worktree",
        "add",
        "-b",
        integrationBranch,
        integrationWorktree,
        baselineCommit,
      ]);
      const commitMode = managedCommitMode(requestedCommitMode);
      const prepared: RunWorktree = { repositoryRoot, baselineCommit, integrationBranch, integrationWorktree, commitMode };
      if (sealedInput.length > 0) {
        prepared.inputTree = await sealWorkingTreeInput(prepared, sealedInput);
        prepared.sealedInputPaths = sealedInput;
      }
      if (!shouldCreateManagedCommit(commitMode)) {
        prepared.integrationTree = await persistIntegrationTree(prepared);
      }
      return prepared;
    } catch (error) {
      try {
        await removeWorktreeIfPresent(repositoryRoot, integrationWorktree, cleanupGit);
        await deleteBranchIfPresent(repositoryRoot, integrationBranch, cleanupGit);
        await rm(root, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "TODO run preparation and cleanup both failed");
      }
      throw error;
    }
  };

  const restoreRun: WorktreeManager["restoreRun"] = async (run) => {
    runRoot(run);
    await git(run.repositoryRoot, ["rev-parse", "--verify", `${run.integrationBranch}^{commit}`]);
    try {
      await git(run.repositoryRoot, ["merge-base", "--is-ancestor", run.baselineCommit, run.integrationBranch]);
    } catch (error) {
      if (error instanceof GitCommandError && error.cleanupConfirmed) {
        throw new Error("The persisted integration branch no longer descends from its baseline commit");
      }
      throw error;
    }
    if (!shouldCreateManagedCommit(run.commitMode) && !run.integrationTree) {
      throw new Error("This TODO run predates persisted no-commit integration state. Start a new run.");
    }
    await removeWorktreeIfPresent(run.repositoryRoot, run.integrationWorktree);
    await git(run.repositoryRoot, ["worktree", "add", run.integrationWorktree, run.integrationBranch]);
    if (!shouldCreateManagedCommit(run.commitMode) && run.integrationTree) {
      await git(run.repositoryRoot, ["cat-file", "-e", `${run.integrationTree}^{tree}`]);
      await git(run.integrationWorktree, ["read-tree", "--reset", "-u", run.integrationTree]);
      await git(run.repositoryRoot, ["update-ref", integrationStateRef(run), run.integrationTree]);
    }
  };

  const prepareTask: WorktreeManager["prepareTask"] = async (run, taskId) => {
    const root = runRoot(run);
    const baseCommit = await git(run.integrationWorktree, ["rev-parse", "HEAD"]);
    const runPart = run.integrationBranch.slice("bachata/integration/".length);
    const taskPart = taskStorageIdentity(taskId);
    const branch = `bachata/task/${runPart}/${taskPart}`;
    const worktreePath = path.join(root, "tasks", taskPart);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    try {
      await removeWorktreeIfPresent(run.repositoryRoot, worktreePath);
      await deleteBranchIfPresent(run.repositoryRoot, branch);
      await git(run.repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
      const sharedDependencies = await linkWorkspaceDependencies(
        worktreePath,
        [run.repositoryRoot],
        worktreePath,
      );
      let baseTree: string | undefined;
      if (!shouldCreateManagedCommit(run.commitMode)) {
        const patchPath = path.join(root, `.bachata-baseline-${taskPart}-${randomBytes(8).toString("hex")}.patch`);
        try {
          const hasPatch = await writeDiffPatch(
            run.integrationWorktree,
            ["--cached", "--binary", "--full-index", baseCommit, "--"],
            patchPath,
          );
          if (hasPatch) {
            await git(worktreePath, ["apply", "--index", "--whitespace=nowarn", patchPath], 300_000, false);
          }
        } finally {
          await rm(patchPath, { force: true }).catch(() => undefined);
        }
        baseTree = await git(worktreePath, ["write-tree"]);
      }
      return {
        taskId,
        branch,
        worktreePath,
        baseCommit,
        commitMode: run.commitMode,
        ...(baseTree ? { baseTree } : {}),
        ...(sharedDependencies.length > 0 ? { sharedDependencies } : {}),
      };
    } catch (error) {
      try {
        await removeWorktreeIfPresent(run.repositoryRoot, worktreePath, cleanupGit);
        await deleteBranchIfPresent(run.repositoryRoot, branch, cleanupGit);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "TODO task preparation and cleanup both failed");
      }
      throw error;
    }
  };

  const overlayWorktreeSnapshot = async (sourceWorktree: string, targetWorktree: string): Promise<void> => {
    // EX-G6-01. Neither half of the enumeration below can name a path that is gone from the
    // index and from the working tree at once, which is exactly what a staged deletion is: it
    // is not `--cached`, because the index entry was removed, and it is not `--others`, because
    // there is no file. The overlay would never visit it, and the snapshot would keep the copy
    // it checked out from HEAD — so every check would run against the bytes the candidate
    // removed. Git is asked directly which paths HEAD has that the candidate does not, and this
    // runs first so a path deleted and then recreated is still recreated.
    const removed = await git(
      sourceWorktree,
      ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=D", "HEAD", "--"],
      120_000,
      false,
    );
    for (const relativePath of uniqueNulPaths(removed)) {
      const targetPath = path.resolve(targetWorktree, relativePath);
      if (!contained(targetWorktree, targetPath)) {
        throw new Error("Validation snapshot path escapes its worktree");
      }
      await rm(targetPath, { recursive: true, force: true });
    }
    const listed = await git(
      sourceWorktree,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      120_000,
      false,
    );
    for (const relativePath of uniqueNulPaths(listed)) {
      const sourcePath = path.resolve(sourceWorktree, relativePath);
      const targetPath = path.resolve(targetWorktree, relativePath);
      if (!contained(sourceWorktree, sourcePath) || !contained(targetWorktree, targetPath)) {
        throw new Error("Validation snapshot path escapes its worktree");
      }
      let info;
      try {
        info = await lstat(sourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await rm(targetPath, { recursive: true, force: true });
          continue;
        }
        throw error;
      }
      if (info.isDirectory()) {
        continue;
      }
      await rm(targetPath, { recursive: true, force: true });
      await mkdir(path.dirname(targetPath), { recursive: true });
      if (info.isSymbolicLink()) {
        await symlink(await readlink(sourcePath), targetPath);
        continue;
      }
      if (info.isFile()) {
        await copyFile(sourcePath, targetPath);
        await chmod(targetPath, info.mode & 0o777);
      }
    }
  };

  const linkWorkspaceDependencies = async (
    manifestWorktree: string,
    sourceRoots: string[],
    targetWorktree: string,
  ): Promise<string[]> => {
    const linked: string[] = [];
    const tracked = uniqueNulPaths(await git(
      manifestWorktree,
      ["ls-files", "-z", "--cached"],
      120_000,
      false,
    ));
    const dependencyPaths = new Set<string>(["node_modules", ".venv", "venv", "vendor"]);
    for (const relativePath of tracked) {
      const normalized = relativePath.replace(/\\/g, "/");
      const base = path.posix.basename(normalized);
      const directory = path.posix.dirname(normalized);
      const prefix = directory === "." ? "" : `${directory}/`;
      if (base === "package.json") dependencyPaths.add(`${prefix}node_modules`);
      if (base === "composer.json") dependencyPaths.add(`${prefix}vendor`);
      if (base === "pyproject.toml" || base === "requirements.txt") {
        dependencyPaths.add(`${prefix}.venv`);
        dependencyPaths.add(`${prefix}venv`);
      }
    }
    for (const relativePath of [...dependencyPaths].sort()) {
      const targetPath = path.resolve(targetWorktree, relativePath);
      if (!contained(targetWorktree, targetPath)) continue;
      try {
        await lstat(targetPath);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let sourcePath: string | undefined;
      for (const sourceRoot of sourceRoots) {
        const candidate = path.resolve(sourceRoot, relativePath);
        if (!contained(sourceRoot, candidate)) continue;
        try {
          const info = await lstat(candidate);
          if (info.isDirectory() || info.isSymbolicLink()) {
            sourcePath = candidate;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!sourcePath) continue;
      await mkdir(path.dirname(targetPath), { recursive: true });
      await symlink(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
      linked.push(relativePath);
    }
    return linked;
  };

  const prepareValidation: WorktreeManager["prepareValidation"] = async (
    run,
    sourceWorktree,
    label,
  ) => {
    const root = runRoot(run);
    if (!contained(root, sourceWorktree)) {
      throw new Error("Validation source is outside the Bachata run directory");
    }
    const token = `${taskStorageIdentity(label)}-${randomBytes(6).toString("hex")}`;
    const worktreePath = await mkdtemp(path.join(tmpdir(), `bachata-validation-${token}-`));
    const head = await git(sourceWorktree, ["rev-parse", "HEAD"]);
    try {
      await git(worktreePath, ["init", "--quiet"]);
      await git(worktreePath, ["fetch", "--no-tags", run.repositoryRoot, head]);
      await git(worktreePath, ["checkout", "--detach", "FETCH_HEAD"]);
      await overlayWorktreeSnapshot(sourceWorktree, worktreePath);
      const sharedDependencies = await linkWorkspaceDependencies(
        sourceWorktree,
        [sourceWorktree, run.repositoryRoot],
        worktreePath,
      );
      return {
        worktreePath,
        snapshotCommit: head,
        ...(sharedDependencies.length > 0 ? { sharedDependencies } : {}),
      };
    } catch (error) {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Validation preparation and cleanup both failed");
      }
      throw error;
    }
  };

  const removeValidation: WorktreeManager["removeValidation"] = async (run, validation) => {
    runRoot(run);
    const worktreePath = path.resolve(validation.worktreePath);
    if (
      path.dirname(worktreePath) !== path.resolve(tmpdir()) ||
      !path.basename(worktreePath).startsWith("bachata-validation-")
    ) {
      throw new Error("Validation repository is outside Bachata temporary storage");
    }
    await rm(worktreePath, { recursive: true, force: true });
  };

  const changedFiles: WorktreeManager["changedFiles"] = async (task) => {
    const [delta, untracked] = await Promise.all([
      git(
        task.worktreePath,
        ["diff", "--name-only", "-z", "--no-renames", taskBaseline(task), "--"],
        120_000,
        false,
      ),
      git(task.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], 120_000, false),
    ]);
    return uniqueNulPaths(delta, untracked);
  };

  /*
   * Rendered for a reviewer, never applied. Untracked files are staged with --intent-to-add so
   * their content appears in the diff, then the index is restored: the review must not be the
   * reason the candidate tree changed between verification and integration.
   */
  const taskPatch: WorktreeManager["taskPatch"] = async (task, maxBytes = 200_000) => {
    await git(task.worktreePath, ["add", "--intent-to-add", "--", "."], 120_000, false);
    try {
      const patch = await git(
        task.worktreePath,
        ["diff", "--no-color", "--no-renames", "--no-ext-diff", taskBaseline(task), "--"],
        300_000,
        false,
      );
      return patch.length > maxBytes
        ? `${patch.slice(0, maxBytes)}\n… diff truncated at ${String(maxBytes)} bytes`
        : patch;
    } finally {
      await git(task.worktreePath, ["reset", "--quiet", "--", "."], 120_000, false);
    }
  };

  const normalizeTaskNoCommit: WorktreeManager["normalizeTaskNoCommit"] = async (task) => {
    const initialHead = await assertTaskLineage(task);
    if (shouldCreateManagedCommit(task.commitMode) || initialHead === task.baseCommit) return;
    await git(task.worktreePath, ["reset", "--mixed", task.baseCommit]);
    const restoredHead = await assertTaskLineage(task);
    if (restoredHead !== task.baseCommit) {
      throw new Error(`Task ${task.taskId} could not be restored to its no-commit base`);
    }
  };

  const commitTask: WorktreeManager["commitTask"] = async (task, title) => {
    await normalizeTaskNoCommit(task);
    const status = await git(
      task.worktreePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      120_000,
      false,
    );
    if (!status) {
      return undefined;
    }
    await git(task.worktreePath, ["add", "--all"]);
    if (!shouldCreateManagedCommit(task.commitMode)) {
      return undefined;
    }
    await git(task.worktreePath, [
      "-c",
      "user.name=Bachata",
      "-c",
      "user.email=bachata@localhost",
      "commit",
      "-m",
      `Bachata ${task.taskId}: ${title}`,
    ]);
    const head = await assertTaskLineage(task);
    if (head === task.baseCommit) {
      return undefined;
    }
    const [baseTree, headTree] = await Promise.all([
      git(task.worktreePath, ["rev-parse", `${task.baseCommit}^{tree}`]),
      git(task.worktreePath, ["rev-parse", `${head}^{tree}`]),
    ]);
    return baseTree === headTree ? undefined : head;
  };

  const integrateTask: WorktreeManager["integrateTask"] = async (run, task, title) => {
    assertTaskOwnership(run, task);
    const taskHead = await assertTaskLineage(task);
    if (!shouldCreateManagedCommit(run.commitMode)) {
      const patchPath = path.join(runRoot(run), `.bachata-${task.taskId}-${randomBytes(8).toString("hex")}.patch`);
      try {
        const hasPatch = await writeDiffPatch(
          task.worktreePath,
          ["--cached", "--binary", "--full-index", taskBaseline(task), "--"],
          patchPath,
        );
        if (hasPatch) {
          await git(
            run.integrationWorktree,
            ["apply", "--3way", "--index", "--whitespace=nowarn", patchPath],
            300_000,
            false,
          );
        }
      } finally {
        await rm(patchPath, { force: true }).catch(() => undefined);
      }
      return persistIntegrationTree(run);
    }
    if (taskHead === task.baseCommit) {
      return git(run.integrationWorktree, ["rev-parse", "HEAD"]);
    }
    try {
      await git(run.integrationWorktree, [
        "-c",
        "user.name=Bachata",
        "-c",
        "user.email=bachata@localhost",
        "merge",
        "--no-ff",
        taskHead,
        "-m",
        `Bachata merge ${task.taskId}: ${title}`,
      ]);
    } catch (error) {
      await confirmedFallback(git(run.integrationWorktree, ["merge", "--abort"]), undefined);
      throw error;
    }
    return git(run.integrationWorktree, ["rev-parse", "HEAD"]);
  };

  const commitIntegration: WorktreeManager["commitIntegration"] = async (run, message) => {
    runRoot(run);
    const status = await git(
      run.integrationWorktree,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    );
    if (!status) {
      return undefined;
    }
    await git(run.integrationWorktree, ["add", "--all"]);
    if (!shouldCreateManagedCommit(run.commitMode)) {
      await persistIntegrationTree(run);
      return undefined;
    }
    await git(run.integrationWorktree, [
      "-c",
      "user.name=Bachata",
      "-c",
      "user.email=bachata@localhost",
      "commit",
      "-m",
      message,
    ]);
    return git(run.integrationWorktree, ["rev-parse", "HEAD"]);
  };

  const integrationCommit: WorktreeManager["integrationCommit"] = async (run) => {
    runRoot(run);
    if (shouldCreateManagedCommit(run.commitMode)) {
      return git(run.integrationWorktree, ["rev-parse", "HEAD"]);
    }
    await git(run.integrationWorktree, ["add", "--all"]);
    return persistIntegrationTree(run);
  };

  const resetIntegration: WorktreeManager["resetIntegration"] = async (run, state) => {
    runRoot(run);
    if (shouldCreateManagedCommit(run.commitMode)) {
      await confirmedFallback(git(run.integrationWorktree, ["merge", "--abort"]), undefined);
      await git(run.integrationWorktree, ["reset", "--hard", state]);
      await git(run.integrationWorktree, ["clean", "-fd"]);
      return;
    }
    await git(run.repositoryRoot, ["cat-file", "-e", `${state}^{tree}`]);
    await git(run.integrationWorktree, ["read-tree", "--reset", "-u", state]);
    await git(run.integrationWorktree, ["clean", "-fd"]);
    await git(run.repositoryRoot, ["update-ref", integrationStateRef(run), state]);
  };

  const integrationStatus: WorktreeManager["integrationStatus"] = (run) => {
    runRoot(run);
    return git(run.integrationWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  };

  const removeTask: WorktreeManager["removeTask"] = async (run, task, deleteBranch = true) => {
    assertTaskOwnership(run, task);
    await removeWorktreeIfPresent(run.repositoryRoot, task.worktreePath, cleanupGit);
    if (deleteBranch) {
      await deleteBranchIfPresent(run.repositoryRoot, task.branch, cleanupGit);
    }
  };

  const cleanupRun: WorktreeManager["cleanupRun"] = async (run) => {
    runRoot(run);
    await cleanupGit(run.repositoryRoot, ["worktree", "prune"]);
  };

  const abandonRun: WorktreeManager["abandonRun"] = async (run) => {
    const root = await canonicalizePath(runRoot(run));
    const ownedWorktrees = (await worktreePaths(run.repositoryRoot, cleanupGit))
      .filter((worktreePath) => contained(root, worktreePath));
    for (const worktreePath of ownedWorktrees) {
      await removeWorktreeIfPresent(run.repositoryRoot, worktreePath, cleanupGit);
    }
    const runPart = run.integrationBranch.slice("bachata/integration/".length);
    const taskBranches = await cleanupGit(
      run.repositoryRoot,
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/bachata/task/${runPart}/`],
      120_000,
      true,
    );
    for (const branch of taskBranches.split(/\r?\n/u).filter(Boolean)) {
      await deleteBranchIfPresent(run.repositoryRoot, branch, cleanupGit);
    }
    await deleteBranchIfPresent(run.repositoryRoot, run.integrationBranch, cleanupGit);
    await confirmedFallback(cleanupGit(run.repositoryRoot, ["update-ref", "-d", integrationStateRef(run)]), undefined);
    await confirmedFallback(cleanupGit(run.repositoryRoot, ["update-ref", "-d", sealedInputRef(run)]), undefined);
    await rm(root, { recursive: true, force: true });
  };

  const patchBase = async (run: RunWorktree): Promise<string> => {
    if (!run.inputTree) return run.baselineCommit;
    await git(run.repositoryRoot, ["rev-parse", "--verify", `${run.inputTree}^{tree}`]);
    return run.inputTree;
  };

  const patchSource = async (run: RunWorktree): Promise<string> => {
    if (run.integrationTree) {
      await git(run.repositoryRoot, ["rev-parse", "--verify", `${run.integrationTree}^{tree}`]);
      return run.integrationTree;
    }
    await git(run.repositoryRoot, ["rev-parse", "--verify", `${run.integrationBranch}^{commit}`]);
    return run.integrationBranch;
  };

  const targetHead: WorktreeManager["targetHead"] = async (run) => {
    runRoot(run);
    return git(run.repositoryRoot, ["rev-parse", "HEAD"]);
  };

  const runChangedPaths: WorktreeManager["runChangedPaths"] = async (run) => {
    runRoot(run);
    return uniqueNulPaths(
      await confirmedFallback(
        git(
          run.repositoryRoot,
          ["diff", "--name-only", "-z", await patchBase(run), await patchSource(run)],
          120_000,
          false,
        ),
        "",
      ),
    );
  };

  const withRunPatchFile = async <T>(
    run: RunWorktree,
    operation: (patchFile: string) => Promise<T>,
  ): Promise<T> => {
    const root = runRoot(run);
    const patchFile = path.join(root, `run-${randomBytes(8).toString("hex")}.patch`);
    if (!contained(root, patchFile)) {
      throw new Error("Refusing to write a run patch outside the run directory");
    }
    try {
      await writeDiffPatch(
        run.repositoryRoot,
        ["--binary", await patchBase(run), await patchSource(run)],
        patchFile,
      );
      return await operation(patchFile);
    } finally {
      await rm(patchFile, { force: true });
    }
  };

  const readRunPatch = async (patchFile: string): Promise<string> => {
    const size = (await stat(patchFile)).size;
    if (size > MAXIMUM_RUN_PATCH_BYTES) {
      throw new Error(
        `This run's diff is ${String(size)} bytes, above the ${String(MAXIMUM_RUN_PATCH_BYTES)}-byte limit Bachata will hold in memory. Apply the whole run, or split the work.`,
      );
    }
    return readFile(patchFile, "utf8");
  };

  const fullPatch = async (run: RunWorktree): Promise<string> =>
    withRunPatchFile(run, readRunPatch);

  const runPatchFiles: WorktreeManager["runPatchFiles"] = async (run) =>
    parsePatchFiles(await fullPatch(run));

  const selectedPatch = async (
    run: RunWorktree,
    selection: PatchSelection | undefined,
  ): Promise<{ patch: string; refusal?: string }> => {
    const patch = await fullPatch(run);
    return selectionIsEmpty(selection) ? { patch } : selectPatch(patch, selection ?? {});
  };

  const runPatch: WorktreeManager["runPatch"] = async (run, selection) => {
    const result = await selectedPatch(run, selection);
    if (result.refusal) throw new Error(result.refusal);
    return result.patch;
  };

  const prepareExportValidation: WorktreeManager["prepareExportValidation"] = async (
    run,
    label,
    selection,
  ) => {
    const root = runRoot(run);
    const token = `${taskStorageIdentity(label)}-${randomBytes(6).toString("hex")}`;
    const worktreePath = await mkdtemp(path.join(tmpdir(), `bachata-validation-${token}-`));
    try {
      await git(worktreePath, ["init", "--quiet"]);
      await git(worktreePath, ["fetch", "--no-tags", run.repositoryRoot, run.baselineCommit]);
      await git(worktreePath, ["checkout", "--detach", "FETCH_HEAD"]);
      if (run.inputTree) {
        const inputPatchPath = path.join(root, `sealed-base-${randomBytes(8).toString("hex")}.patch`);
        try {
          const hasInputPatch = await writeDiffPatch(
            run.repositoryRoot,
            ["--binary", "--full-index", run.baselineCommit, await patchBase(run)],
            inputPatchPath,
          );
          if (hasInputPatch) {
            await git(
              worktreePath,
              ["apply", "--index", "--whitespace=nowarn", inputPatchPath],
              300_000,
              false,
            );
          }
        } finally {
          await rm(inputPatchPath, { force: true }).catch(() => undefined);
        }
      }
      const selected = await selectedPatch(run, selection);
      if (selected.refusal) {
        throw new Error(selected.refusal);
      }
      if (selected.patch.trim().length > 0) {
        const patchFile = path.join(root, `export-${randomBytes(8).toString("hex")}.patch`);
        if (!contained(root, patchFile)) {
          throw new Error("Refusing to write an export patch outside the run directory");
        }
        await writeFile(patchFile, selected.patch, "utf8");
        try {
          await git(
            worktreePath,
            ["apply", "--index", "--whitespace=nowarn", patchFile],
            300_000,
            false,
          );
        } finally {
          await rm(patchFile, { force: true }).catch(() => undefined);
        }
      }
      const sharedDependencies = await linkWorkspaceDependencies(
        run.integrationWorktree,
        [run.integrationWorktree, run.repositoryRoot],
        worktreePath,
      );
      return {
        worktreePath,
        snapshotCommit: await patchBase(run),
        ...(sharedDependencies.length > 0 ? { sharedDependencies } : {}),
      };
    } catch (error) {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Export validation preparation and cleanup both failed",
        );
      }
      throw error;
    }
  };

  const failedPatchPaths = (message: string): string[] =>
    Array.from(new Set(
      Array.from(message.matchAll(/error: patch failed: ([^\s:]+)/gu), (match) => match[1])
        .filter((candidate): candidate is string => candidate !== undefined),
    ));

  const applyRun: WorktreeManager["applyRun"] = async (run, selection) => {
    const root = runRoot(run);
    const targetBranch = await confirmedFallback(
      git(run.repositoryRoot, ["symbolic-ref", "-q", "--short", "HEAD"]),
      "DETACHED",
    );
    const refuse = (reason: string, conflicts: string[] = []): ApplyRunResult => ({
      applied: false,
      targetBranch,
      stagedFiles: [],
      conflicts,
      reason,
    });
    if (targetBranch === "DETACHED") {
      return refuse("The repository HEAD is detached. Check out the branch that should receive this work.");
    }
    if (targetBranch.startsWith("bachata/")) {
      return refuse("The repository is on an extension-owned branch. Check out your own branch first.");
    }
    const status = await git(
      run.repositoryRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      120_000,
      false,
    );
    const dirty = uniqueNulPaths(...parseGitStatus(status).flatMap((entry) => entry.paths));
    if (dirty.length > 0) {
      return refuse(
        `Commit, stash, or discard the working tree first. Dirty paths: ${dirty.slice(0, 20).join(", ")}`,
      );
    }
    try {
      await git(run.repositoryRoot, ["merge-base", "--is-ancestor", run.baselineCommit, "HEAD"]);
    } catch {
      return refuse(
        `${targetBranch} no longer contains the commit this run started from. Rebase, or apply the exported patch by hand.`,
      );
    }
    // EX-G6-02. A sealed run's patch is `inputTree..candidate`, so nothing the sealing carried
    // is inside it: the run was given files the target may never have held, and the work was
    // written against them. Untracked input is the sharp case — a helper module sealed as run
    // input is a dependency of the work rather than a line of it, so Apply would stage code
    // importing a file that is not there and `git apply --check` would see nothing wrong,
    // because the missing file appears in no hunk. The target has to already hold exactly what
    // the run was sealed with.
    if (run.inputTree !== undefined && (run.sealedInputPaths?.length ?? 0) > 0) {
      // EX-A5-R03. The whole tree entry, not the object it names. `rev-parse tree:path` answers
      // with a blob id, which covers content and nothing else — so a sealed file that is
      // executable and a target copy that is not compared equal, and the export deliberately
      // carries no sealed input, so the mode reached the branch from nowhere and the applied
      // program exited 126. `ls-tree` answers with mode, type and object together, and with
      // nothing at all for a path the tree does not hold, so absence is compared too.
      const sealedEntry = async (revision: string, relative: string): Promise<string> =>
        await confirmedFallback(
          git(run.repositoryRoot, ["ls-tree", "--full-tree", "-z", revision, "--", relative], 120_000, false),
          "",
        );
      const missing: string[] = [];
      for (const relative of run.sealedInputPaths ?? []) {
        const sealed = await sealedEntry(run.inputTree, relative);
        const present = await sealedEntry("HEAD", relative);
        if (sealed !== present) missing.push(relative);
      }
      if (missing.length > 0) {
        return refuse(
          `${targetBranch} no longer holds the input this run was sealed with, so the work would be applied against different files than it was written against. Commit or restore: ${missing.slice(0, 20).join(", ")}`,
          missing,
        );
      }
    }
    const empty = selectionIsEmpty(selection);
    const selectedPaths = [
      ...(selection?.paths ?? []),
      ...(selection?.hunks ?? []).map((reference) => reference.path),
    ];
    if (selectedPaths.length > 0) {
      const changed = new Set(await runChangedPaths(run));
      const unknown = Array.from(new Set(selectedPaths.filter((candidate) => !changed.has(candidate))));
      if (unknown.length > 0) {
        return refuse(
          `Bachata refuses to apply paths this run did not change: ${unknown.slice(0, 20).join(", ")}`,
          unknown,
        );
      }
    }
    const applyPatchFile = async (patchFile: string): Promise<ApplyRunResult | undefined> => {
      try {
        await git(run.repositoryRoot, ["apply", "--index", "--check", "--whitespace=nowarn", patchFile], 300_000, false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return refuse(
          "The retained work no longer applies cleanly to this branch. The working tree was not touched and the run worktree was kept.",
          failedPatchPaths(message),
        );
      }
      await git(run.repositoryRoot, ["apply", "--index", "--whitespace=nowarn", patchFile], 300_000, false);
      return undefined;
    };

    const refusal = await withRunPatchFile(run, async (runPatchFile) => {
      if ((await stat(runPatchFile)).size === 0) {
        return refuse("This run changed nothing, so there is nothing to apply.");
      }
      if (empty) {
        return applyPatchFile(runPatchFile);
      }
      const selected = selectPatch(await readRunPatch(runPatchFile), selection ?? {});
      if (selected.refusal) return refuse(selected.refusal);
      if (selected.patch.trim().length === 0) {
        return refuse("The selected work carries no change from this run, so there is nothing to apply.");
      }
      const patchFile = path.join(root, `apply-${randomBytes(8).toString("hex")}.patch`);
      await writeFile(patchFile, selected.patch, "utf8");
      try {
        return await applyPatchFile(patchFile);
      } finally {
        await rm(patchFile, { force: true });
      }
    });
    if (refusal) return refusal;
    const staged = uniqueNulPaths(
      await confirmedFallback(
        git(run.repositoryRoot, ["diff", "--name-only", "-z", "--cached"], 120_000, false),
        "",
      ),
    );
    return { applied: true, targetBranch, stagedFiles: staged, conflicts: [] };
  };

  const withAdministration = async <T>(
    workspaceRoot: string,
    label: string,
    operation: () => Promise<T>,
    cleanup = false,
  ): Promise<T> => {
    if (!options.resourceBroker) {
      return operation();
    }
    const identity = await repositoryIdentityUsing(
      workspaceRoot,
      cleanup ? cleanupGit : git,
    );
    const lease = await options.resourceBroker.acquire({
      resources: [gitAdministrationClaim(identity)],
      deadlineAt: Date.now() + Math.max(1_000, options.lockTimeoutMs?.() ?? 120_000),
      label,
    });
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    if (operationError !== undefined) {
      const unsafe = unconfirmedGitErrors(operationError);
      if (unsafe.length > 0) {
        try {
          await lease.quarantine(
            `Git process cleanup was not confirmed: ${unsafe.map((value) => value.message).join(" | ")}`,
          );
        } catch (quarantineError) {
          throw new AggregateError(
            [operationError, quarantineError],
            "Git operation failed and its administration resource could not be quarantined",
          );
        }
        throw operationError;
      }
      try {
        await lease.release();
      } catch (releaseError) {
        try {
          await lease.quarantine(
            `Git administration lease release was not confirmed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          );
        } catch (quarantineError) {
          throw new AggregateError(
            [operationError, releaseError, quarantineError],
            "Git operation failed and its administration lease could neither be released nor quarantined",
          );
        }
        throw new AggregateError(
          [operationError, releaseError],
          "Git operation failed and its administration lease release was not confirmed",
        );
      }
      throw operationError;
    }

    try {
      await lease.release();
    } catch (releaseError) {
      try {
        await lease.quarantine(
          `Git administration lease release was not confirmed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      } catch (quarantineError) {
        throw new AggregateError(
          [releaseError, quarantineError],
          "Git administration completed but its lease could neither be released nor quarantined",
        );
      }
      throw new AggregateError(
        [releaseError],
        "Git administration completed but its lease release was not confirmed",
      );
    }
    return result as T;
  };

  return {
    repositoryIdentity,
    preflightRun: (workspaceRoot, allowedDirtyPaths, sealedInputPaths) =>
      withAdministration(workspaceRoot, "preflight TODO orchestration", () =>
        preflightRun(workspaceRoot, allowedDirtyPaths, sealedInputPaths)),
    dirtyRepositoryPaths,
    prepareRun: (workspaceRoot, runId, allowedDirtyPaths, commitMode, sealedInputPaths) =>
      withAdministration(workspaceRoot, `prepare TODO run ${runId}`, () =>
        prepareRun(workspaceRoot, runId, allowedDirtyPaths, commitMode, sealedInputPaths)),
    restoreRun: (run) =>
      withAdministration(run.repositoryRoot, `restore TODO run ${run.integrationBranch}`, () => restoreRun(run)),
    prepareTask: (run, taskId) =>
      withAdministration(run.repositoryRoot, `prepare TODO task ${taskId}`, () => prepareTask(run, taskId)),
    prepareValidation: (run, sourceWorktree, label) =>
      withAdministration(run.repositoryRoot, `prepare validation ${label}`, () =>
        prepareValidation(run, sourceWorktree, label)),
    removeValidation,
    worktreeState,
    changedFiles,
    taskPatch: (task, maxBytes) =>
      withAdministration(task.worktreePath, `render TODO task ${task.taskId} diff`, () => taskPatch(task, maxBytes)),
    normalizeTaskNoCommit: (task) =>
      withAdministration(task.worktreePath, `normalize TODO task ${task.taskId} no-commit state`, () => normalizeTaskNoCommit(task)),
    commitTask: (task, title) =>
      withAdministration(task.worktreePath, `commit TODO task ${task.taskId}`, () => commitTask(task, title)),
    integrateTask: (run, task, title) =>
      withAdministration(run.repositoryRoot, `integrate TODO task ${task.taskId}`, () => integrateTask(run, task, title)),
    commitIntegration: (run, message) =>
      withAdministration(run.repositoryRoot, `commit TODO integration ${run.integrationBranch}`, () =>
        commitIntegration(run, message)),
    integrationCommit,
    resetIntegration: (run, commit) =>
      withAdministration(run.repositoryRoot, `reset TODO integration ${run.integrationBranch}`, () =>
        resetIntegration(run, commit)),
    integrationStatus,
    removeTask: (run, task, deleteBranch) =>
      withAdministration(run.repositoryRoot, `remove TODO task ${task.taskId}`, () =>
        removeTask(run, task, deleteBranch), true),
    cleanupRun: (run) =>
      withAdministration(run.repositoryRoot, `clean TODO run ${run.integrationBranch}`, () => cleanupRun(run), true),
    abandonRun: (run) =>
      withAdministration(run.repositoryRoot, `abandon TODO run ${run.integrationBranch}`, () => abandonRun(run), true),
    prepareExportValidation,
    runPatch,
    runChangedPaths,
    targetHead,
    runPatchFiles,
    applyRun: (run, paths) =>
      withAdministration(run.repositoryRoot, `apply TODO run ${run.integrationBranch}`, () => applyRun(run, paths), true),
  };
};
