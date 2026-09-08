import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout } from "node:timers/promises";
import * as path from "node:path";

import {
  isPathInsideRoot,
  normalizePathIdentity,
  samePathIdentity,
} from "../process/pathBoundary";

export type PipelineScope = {
  key: string;
  directory: string;
  root?: string;
  canonicalRoot?: string;
};

export type PipelineCatalogMutationRunner = <T>(
  catalogDirectory: string,
  operation: () => Promise<T>,
) => Promise<T>;

export type PipelineCatalogLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
};

export class PipelineCatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineCatalogConflictError";
  }
}

const normalizeIdentity = normalizePathIdentity;

const samePath = samePathIdentity;

export const isPathInside = isPathInsideRoot;

export const canonicalizePath = async (value: string): Promise<string> => {
  const tail: string[] = [];
  let candidate = path.resolve(value);
  while (true) {
    try {
      return path.join(await realpath(candidate), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      tail.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
};

const rootIdentity = async (displayRoot: string): Promise<{
  displayRoot: string;
  canonicalRoot: string;
}> => ({
  displayRoot: path.resolve(displayRoot),
  canonicalRoot: await canonicalizePath(displayRoot),
});

export const resolvePipelineScope = async (values: {
  workingDirectory?: string | undefined;
  workspaceRoots: string[];
  configuredRoot?: string | undefined;
  extensionDirectory: string;
}): Promise<PipelineScope> => {
  const roots = await Promise.all(values.workspaceRoots.map(rootIdentity));
  const canonicalWorkingDirectory = values.workingDirectory
    ? await canonicalizePath(values.workingDirectory)
    : undefined;
  const matchingRoot = canonicalWorkingDirectory
    ? roots
        .filter(({ canonicalRoot }) =>
          isPathInside(canonicalRoot, canonicalWorkingDirectory)
        )
        .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)[0]
    : undefined;
  const configuredRoot = values.configuredRoot
    ? await rootIdentity(values.configuredRoot)
    : undefined;
  const currentConfiguredRoot = configuredRoot
    ? roots.find(({ canonicalRoot }) => samePath(canonicalRoot, configuredRoot.canonicalRoot))
    : undefined;
  const selectedRoot = matchingRoot ?? currentConfiguredRoot ??
    (roots.length === 1 ? roots[0] : undefined);
  if (selectedRoot) {
    const directory = await canonicalizePath(
      path.join(selectedRoot.canonicalRoot, ".bachata", "pipelines"),
    );
    if (!isPathInside(selectedRoot.canonicalRoot, directory)) {
      throw new Error(
        `The Bachata pipeline directory resolves outside workspace root ${selectedRoot.displayRoot}`,
      );
    }
    return {
      key: `workspace:${normalizeIdentity(selectedRoot.canonicalRoot)}`,
      directory,
      root: selectedRoot.displayRoot,
      canonicalRoot: selectedRoot.canonicalRoot,
    };
  }
  const directory = await canonicalizePath(values.extensionDirectory);
  return {
    key: `extension:${normalizeIdentity(directory)}`,
    directory,
  };
};

export const assertPipelineScopeSafe = async (
  scope: PipelineScope,
): Promise<void> => {
  const currentDirectory = await canonicalizePath(scope.directory);
  if (!samePath(currentDirectory, scope.directory)) {
    throw new Error("The Bachata pipeline directory changed on disk. Reload the VS Code window.");
  }
  if (
    scope.canonicalRoot &&
    !isPathInside(scope.canonicalRoot, currentDirectory)
  ) {
    throw new Error(
      `The Bachata pipeline directory resolves outside workspace root ${scope.root ?? scope.canonicalRoot}`,
    );
  }
};

const delay = (milliseconds: number): Promise<void> => setTimeout(milliseconds, undefined);

type PipelineCatalogLockOwner = {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

const lockOwnerText = (token: string): string =>
  `${JSON.stringify({
    token,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  })}\n`;

const parseLockOwner = (value: string): PipelineCatalogLockOwner | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<PipelineCatalogLockOwner>;
    if (
      typeof parsed.token !== "string" ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return undefined;
    }
    return parsed as PipelineCatalogLockOwner;
  } catch {
    return undefined;
  }
};

/** What deciding whether a lock owner is still running needs from the host. */
export type ProcessLivenessHost = {
  platform: string;
  /** The `/proc/<pid>/stat` line. Throws when the entry is absent or unreadable. */
  readProcessStat: (pid: number) => string;
  /** A zero signal. Throws `ESRCH` for a dead pid and `EPERM` for one owned elsewhere. */
  signalProcess: (pid: number) => void;
};

/**
 * Whether a recorded lock owner is still running.
 *
 * A zero signal answers for a pid that exists, but a zombie still answers it: the process is
 * gone and only its exit status is left, so on Linux `/proc` is read first to rule that out.
 * That read is an optimisation, not the answer — an entry that cannot be read leaves liveness
 * undecided, and the signal below decides. `EPERM` means the pid exists and belongs to
 * another user, which is still alive.
 */
export const processIsAlive = (pid: number, host: ProcessLivenessHost): boolean => {
  if (host.platform === "linux") {
    try {
      const stat = host.readProcessStat(pid);
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd >= 0) {
        const state = stat.slice(commandEnd + 2).trim().split(/\s+/u)[0];
        if (state === "Z") {
          return false;
        }
      }
    } catch {
      // EX-AUD-13. Undecided, which is what the signal probe below answers.
    }
  }
  try {
    host.signalProcess(pid);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const localProcessIsAlive = (pid: number): boolean =>
  processIsAlive(pid, {
    platform: process.platform,
    readProcessStat: (target) => readFileSync(`/proc/${String(target)}/stat`, "utf8"),
    signalProcess: (target) => {
      process.kill(target, 0);
    },
  });

const reclaimIntentPrefix = ".pipeline-catalog.reclaim-";

const mayReclaimLockOwner = (owner: PipelineCatalogLockOwner | undefined): boolean =>
  !owner || (owner.hostname === hostname() && !localProcessIsAlive(owner.pid));

const removeStaleReclaimIntents = async (
  directory: string,
  staleMs: number,
): Promise<number> => {
  const entries = await readdir(directory, { withFileTypes: true });
  let active = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(reclaimIntentPrefix)) {
      continue;
    }
    const intentPath = path.join(directory, entry.name);
    const details = await lstat(intentPath).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error)
    );
    if (!details) {
      continue;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Refusing to use an invalid Bachata pipeline catalog reclaim intent");
    }
    if (Date.now() - details.mtimeMs <= staleMs) {
      active += 1;
      continue;
    }
    const ownerText = await readFile(intentPath, "utf8").catch(
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error),
    );
    if (ownerText === undefined) {
      continue;
    }
    if (!mayReclaimLockOwner(parseLockOwner(ownerText))) {
      active += 1;
      continue;
    }
    await rm(intentPath, { force: true });
  }
  return active;
};

const createReclaimIntent = async (
  directory: string,
  token: string,
): Promise<{ path: string; release: () => Promise<void> }> => {
  const intentPath = path.join(directory, `${reclaimIntentPrefix}${token}`);
  const handle = await open(intentPath, "wx", 0o600);
  try {
    await handle.writeFile(lockOwnerText(token), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(intentPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  let released = false;
  return {
    path: intentPath,
    release: async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      const current = await readFile(intentPath, "utf8").catch(
        (error: NodeJS.ErrnoException) =>
          error.code === "ENOENT" ? undefined : Promise.reject(error),
      );
      if (current === undefined) {
        return;
      }
      if (parseLockOwner(current)?.token !== token) {
        throw new Error("The Bachata pipeline catalog reclaim intent was replaced");
      }
      await rm(intentPath);
    },
  };
};

const acquirePipelineCatalogFileLock = async (
  scope: PipelineScope,
  options: PipelineCatalogLockOptions,
): Promise<() => Promise<void>> => {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
  const staleMs = Math.max(10_000, options.staleMs ?? 60_000);
  const heartbeatMs = Math.max(1_000, Math.min(5_000, Math.floor(staleMs / 4)));
  const deadlineAt = Date.now() + timeoutMs;
  const token = randomUUID();
  await assertPipelineScopeSafe(scope);
  await mkdir(scope.directory, { recursive: true });
  await assertPipelineScopeSafe(scope);
  const lockPath = path.join(scope.directory, ".pipeline-catalog.lock");

  while (true) {
    await assertPipelineScopeSafe(scope);
    if (await removeStaleReclaimIntents(scope.directory, staleMs) > 0) {
      if (Date.now() >= deadlineAt) {
        throw new Error("Timed out waiting for the Bachata pipeline catalog file lock");
      }
      await delay(Math.min(100, Math.max(20, deadlineAt - Date.now())));
      continue;
    }

    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(lockOwnerText(token), "utf8");
        await handle.sync();
        if (await removeStaleReclaimIntents(scope.directory, staleMs) > 0) {
          await handle.close();
          const current = await readFile(lockPath, "utf8").catch(
            (readError: NodeJS.ErrnoException) =>
              readError.code === "ENOENT" ? undefined : Promise.reject(readError),
          );
          if (parseLockOwner(current ?? "")?.token === token) {
            await rm(lockPath, { force: true });
          }
          if (Date.now() >= deadlineAt) {
            throw new Error("Timed out waiting for the Bachata pipeline catalog file lock");
          }
          await delay(Math.min(100, Math.max(20, deadlineAt - Date.now())));
          continue;
        }
      } catch (error) {
        await handle.close().catch(() => undefined);
        const current = await readFile(lockPath, "utf8").catch(
          (readError: NodeJS.ErrnoException) =>
            readError.code === "ENOENT" ? undefined : Promise.reject(readError),
        );
        if (parseLockOwner(current ?? "")?.token === token) {
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref?.();
      let released = false;
      return async (): Promise<void> => {
        if (released) {
          return;
        }
        released = true;
        clearInterval(heartbeat);
        await handle.close();
        const current = await readFile(lockPath, "utf8").catch((error: NodeJS.ErrnoException) =>
          error.code === "ENOENT" ? undefined : Promise.reject(error)
        );
        if (current === undefined) {
          throw new Error("The Bachata pipeline catalog lock disappeared before release");
        }
        const currentOwner = parseLockOwner(current);
        if (currentOwner?.token !== token) {
          throw new Error("The Bachata pipeline catalog lock was replaced before release");
        }
        await rm(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const details = await lstat(lockPath).catch((lockError: NodeJS.ErrnoException) =>
        lockError.code === "ENOENT" ? undefined : Promise.reject(lockError)
      );
      if (!details) {
        continue;
      }
      if (details.isSymbolicLink()) {
        throw new Error("Refusing to use a symbolic link as the Bachata pipeline catalog lock");
      }
      if (!details.isFile()) {
        throw new Error("Refusing to use a non-file as the Bachata pipeline catalog lock");
      }
      if (Date.now() - details.mtimeMs > staleMs) {
        const intent = await createReclaimIntent(scope.directory, randomUUID());
        let reclaimed = false;
        try {
          const currentDetails = await lstat(lockPath).catch(
            (lockError: NodeJS.ErrnoException) =>
              lockError.code === "ENOENT" ? undefined : Promise.reject(lockError),
          );
          if (
            currentDetails &&
            !currentDetails.isSymbolicLink() &&
            currentDetails.isFile() &&
            Date.now() - currentDetails.mtimeMs > staleMs
          ) {
            const ownerText = await readFile(lockPath, "utf8").catch(
              (ownerError: NodeJS.ErrnoException) =>
                ownerError.code === "ENOENT" ? undefined : Promise.reject(ownerError),
            );
            if (
              ownerText !== undefined &&
              mayReclaimLockOwner(parseLockOwner(ownerText))
            ) {
              await rm(lockPath, { force: true });
              reclaimed = true;
            }
          }
        } finally {
          await intent.release();
        }
        if (reclaimed) {
          continue;
        }
      }
      if (Date.now() >= deadlineAt) {
        throw new Error("Timed out waiting for the Bachata pipeline catalog file lock");
      }
      await delay(Math.min(100, Math.max(20, deadlineAt - Date.now())));
    }
  }
};

export const withPipelineCatalogFileLock = async <T>(
  scope: PipelineScope,
  operation: () => Promise<T>,
  options: PipelineCatalogLockOptions = {},
): Promise<T> => {
  const release = await acquirePipelineCatalogFileLock(scope, options);
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (operationError !== undefined) {
      throw new AggregateError(
        [operationError, releaseError],
        "Pipeline catalog mutation failed and its file lock could not be released",
      );
    }
    throw releaseError;
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return result as T;
};

const assertCatalogFilePath = (
  scope: PipelineScope,
  filePath: string,
): void => {
  if (!samePath(path.dirname(path.resolve(filePath)), scope.directory)) {
    throw new Error("Pipeline catalog files must stay in the active catalog directory");
  }
};

export const readCatalogText = async (
  scope: PipelineScope,
  filePath: string,
): Promise<string | undefined> => {
  assertCatalogFilePath(scope, filePath);
  const details = await lstat(filePath).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error)
  );
  if (!details) {
    return undefined;
  }
  if (details.isSymbolicLink()) {
    throw new Error(`Refusing to read symbolic-link pipeline file ${filePath}`);
  }
  if (!details.isFile()) {
    throw new Error(`Pipeline path is not a regular file: ${filePath}`);
  }
  return readFile(filePath, "utf8");
};

const assertExpectedText = (
  filePath: string,
  current: string | undefined,
  expected: string | undefined,
): void => {
  if (current !== expected) {
    throw new PipelineCatalogConflictError(
      `Pipeline file ${path.basename(filePath)} changed on disk. Reopen it before continuing.`,
    );
  }
};


export const reconcilePipelineCatalogArtifacts = async (scope: PipelineScope): Promise<void> => {
  await assertPipelineScopeSafe(scope);
  const entries = await readdir(scope.directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const conflicts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^\.(.+\.pipeline\.json)\.(\d+)\.([^.]+)\.previous$/);
    const [, targetName, sequence, suffix] = match ?? [];
    if (targetName === undefined || sequence === undefined || suffix === undefined) continue;
    const priorPath = path.join(scope.directory, entry.name);
    const targetPath = path.join(scope.directory, targetName);
    const temporaryPath = path.join(scope.directory, `.${targetName}.${sequence}.${suffix}.tmp`);
    const priorText = await readCatalogText(scope, priorPath);
    if (priorText === undefined) continue;
    const temporaryText = await readCatalogText(scope, temporaryPath);
    let targetText = await readCatalogText(scope, targetPath);
    if (targetText === undefined) {
      try {
        await link(priorPath, targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      targetText = await readCatalogText(scope, targetPath);
    }
    if (targetText === priorText || temporaryText === undefined || targetText === temporaryText) {
      await rm(priorPath, { force: true });
      await rm(temporaryPath, { force: true });
      continue;
    }
    conflicts.push(entry.name);
  }
  if (conflicts.length > 0) {
    throw new PipelineCatalogConflictError(
      `Pipeline catalog recovery found concurrent content for ${conflicts.join(", ")}; preserved the staged prior version`,
    );
  }
};

export const writeCatalogTextIfUnchanged = async (
  scope: PipelineScope,
  filePath: string,
  content: string,
  expected: string | undefined,
): Promise<void> => {
  await assertPipelineScopeSafe(scope);
  await mkdir(scope.directory, { recursive: true });
  await assertPipelineScopeSafe(scope);
  assertExpectedText(filePath, await readCatalogText(scope, filePath), expected);
  const transactionId = randomUUID();
  const temporaryPath = path.join(
    scope.directory,
    `.${path.basename(filePath)}.${String(process.pid)}.${transactionId}.tmp`,
  );
  const originalPath = path.join(
    scope.directory,
    `.${path.basename(filePath)}.${String(process.pid)}.${transactionId}.previous`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  let originalStaged = false;
  let originalMatched = false;
  try {
    if (expected !== undefined) {
      try {
        await rename(filePath, originalPath);
        originalStaged = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new PipelineCatalogConflictError(
            `Pipeline file ${path.basename(filePath)} changed on disk. Reopen it before continuing.`,
          );
        }
        throw error;
      }
      const stagedText = await readCatalogText(scope, originalPath);
      assertExpectedText(filePath, stagedText, expected);
      originalMatched = true;
    } else {
      assertExpectedText(filePath, await readCatalogText(scope, filePath), undefined);
    }

    await assertPipelineScopeSafe(scope);
    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PipelineCatalogConflictError(
          `Pipeline file ${path.basename(filePath)} changed on disk. Reopen it before continuing.`,
        );
      }
      throw error;
    }
    await rm(temporaryPath);
    if (originalStaged) {
      await rm(originalPath);
      originalStaged = false;
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (originalStaged) {
      const current = await readCatalogText(scope, filePath).catch(() => undefined);
      if (current === undefined) {
        try {
          await link(originalPath, filePath);
          await rm(originalPath);
          originalStaged = false;
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new AggregateError(
              [error, restoreError],
              `Pipeline file ${path.basename(filePath)} changed and its prior content could not be restored`,
            );
          }
        }
      } else if (originalMatched) {
        await rm(originalPath, { force: true });
        originalStaged = false;
      }
    }
    if (originalStaged) {
      throw new AggregateError(
        [error],
        `Pipeline file ${path.basename(filePath)} changed concurrently; preserved prior content at ${path.basename(originalPath)}`,
      );
    }
    throw error;
  }
};

export const stageCatalogDeleteIfUnchanged = async (
  scope: PipelineScope,
  filePath: string,
  expected: string,
  tombstone = `${filePath}.delete-${randomUUID()}`,
): Promise<string> => {
  await assertPipelineScopeSafe(scope);
  assertCatalogFilePath(scope, filePath);
  if (!samePath(path.dirname(path.resolve(tombstone)), scope.directory)) {
    throw new Error("Pipeline deletion staging must stay in the active catalog directory");
  }
  const staged = await lstat(tombstone).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error)
  );
  if (staged) {
    throw new PipelineCatalogConflictError(
      `Pipeline deletion staging path already exists: ${path.basename(tombstone)}`,
    );
  }
  try {
    await rename(filePath, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PipelineCatalogConflictError(
        `Pipeline file ${path.basename(filePath)} changed on disk. Reopen it before continuing.`,
      );
    }
    throw error;
  }
  let conflict: unknown;
  try {
    const stagedText = await readCatalogText(scope, tombstone);
    if (stagedText === expected) {
      return tombstone;
    }
    conflict = new PipelineCatalogConflictError(
      `Pipeline file ${path.basename(filePath)} changed on disk. Reopen it before continuing.`,
    );
  } catch (error) {
    conflict = error;
  }
  try {
    await link(tombstone, filePath);
    await rm(tombstone);
  } catch (restoreError) {
    if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new AggregateError(
        [conflict, restoreError],
        `Pipeline deletion conflict could not restore ${path.basename(filePath)}`,
      );
    }
    throw new AggregateError(
      [conflict],
      `Pipeline deletion conflict preserved concurrent content at ${path.basename(tombstone)}`,
    );
  }
  throw conflict;
};

export const finalizeCatalogDeleteIfAbsent = async (
  scope: PipelineScope,
  filePath: string,
  tombstone: string,
): Promise<void> => {
  await assertPipelineScopeSafe(scope);
  assertExpectedText(filePath, await readCatalogText(scope, filePath), undefined);
  const tombstoneDetails = await lstat(tombstone);
  if (!tombstoneDetails.isFile()) {
    throw new Error("The staged pipeline deletion is not a regular file");
  }
  await rm(tombstone);
  assertExpectedText(filePath, await readCatalogText(scope, filePath), undefined);
};

export const removeCatalogTextIfUnchanged = async (
  scope: PipelineScope,
  filePath: string,
  expected: string,
): Promise<void> => {
  const tombstone = await stageCatalogDeleteIfUnchanged(scope, filePath, expected);
  await finalizeCatalogDeleteIfAbsent(scope, filePath, tombstone);
};

export const restoreCatalogDeleteIfAbsent = async (
  scope: PipelineScope,
  filePath: string,
  tombstone: string,
): Promise<void> => {
  await assertPipelineScopeSafe(scope);
  assertExpectedText(filePath, await readCatalogText(scope, filePath), undefined);
  const tombstoneDetails = await lstat(tombstone);
  if (!tombstoneDetails.isFile()) {
    throw new Error("The staged pipeline deletion is not a regular file");
  }
  try {
    await link(tombstone, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PipelineCatalogConflictError(
        `Pipeline file ${path.basename(filePath)} changed while its deletion was rolling back`,
      );
    }
    throw error;
  }
  await rm(tombstone);
};
