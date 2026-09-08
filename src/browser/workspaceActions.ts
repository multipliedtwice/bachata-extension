import {
  assertExpectedFileHashes,
  assertWorkspaceActionAllowed,
  assertWorkspaceActionPathsAllowed,
  assertWorkspacePathAllowed,
  deriveMutationContext,
  extractPatchPaths,
  isRestrictedWorkspacePath as isPolicyRestrictedWorkspacePath,
  MutationPolicyContext,
  normalizeWorkspaceRelativePath,
} from "./mutationPolicy";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  appendBoundedBuffer,
  boundedBufferText,
  createBoundedBuffer,
  truncateUtf8Text,
} from "../process/boundedOutput";
import { spawnProcessScope } from "../process/processScope";
import { gitProcessEnvironment } from "../process/safeEnvironment";
import { isPathInsideRoot } from "../process/pathBoundary";
import {
  BrowserActionCandidate,
  BrowserActionExecutionResult,
  describeBrowserAction,
} from "./actions";

export type BrowserActionExecutorOptions = {
  workingDirectory: string;
  signal: AbortSignal;
  timeoutMs: number;
  terminateGraceMs: number;
  maxOutputBytes: number;
  maxReadBytes: number;
  maxSearchResults: number;
  mutationContext?: MutationPolicyContext;
};

type ActionGuard = {
  signal: AbortSignal;
  timeoutMs: number;
  deadline: number;
};

const createGuard = (options: BrowserActionExecutorOptions): ActionGuard => ({
  signal: options.signal,
  timeoutMs: options.timeoutMs,
  deadline: Date.now() + options.timeoutMs,
});

const assertActive = (guard: ActionGuard): void => {
  if (guard.signal.aborted) {
    throw new Error("Browser action was interrupted");
  }
  if (Date.now() >= guard.deadline) {
    throw new Error(
      `Browser action timed out after ${String(guard.timeoutMs)} ms`,
    );
  }
};

const checked = async <T>(guard: ActionGuard, value: Promise<T>): Promise<T> => {
  assertActive(guard);
  const result = await value;
  assertActive(guard);
  return result;
};

const remainingTimeoutMs = (guard: ActionGuard): number => {
  assertActive(guard);
  return Math.max(1, guard.deadline - Date.now());
};

const isInside = isPathInsideRoot;

const resolveRoot = async (
  workingDirectory: string,
  guard: ActionGuard,
): Promise<string> => checked(guard, realpath(workingDirectory));

const lexicalPath = (
  root: string,
  value: string | undefined,
  allowRoot: boolean,
): string => {
  const candidate = path.resolve(root, value === undefined || value.length === 0 ? "." : value);
  if (!isInside(root, candidate) || (!allowRoot && candidate === root)) {
    throw new Error("Workspace action path is outside the working directory");
  }
  return candidate;
};

type ExistingWorkspacePath = {
  lexical: string;
  resolved: string;
};

const resolveExistingPath = async (
  root: string,
  value: string | undefined,
  guard: ActionGuard,
): Promise<ExistingWorkspacePath> => {
  const lexical = lexicalPath(root, value, true);
  const resolved = await checked(guard, realpath(lexical));
  if (!isInside(root, resolved)) {
    throw new Error("Workspace action path resolves outside the working directory");
  }
  return { lexical, resolved };
};

const resolveWritablePath = async (
  root: string,
  value: string | undefined,
  guard: ActionGuard,
): Promise<string> => {
  if (value === undefined || value.length === 0) {
    throw new Error("Workspace action requires a path");
  }
  const candidate = lexicalPath(root, value, false);
  let existingAncestor = path.dirname(candidate);
  for (;;) {
    assertActive(guard);
    try {
      const resolvedAncestor = await checked(guard, realpath(existingAncestor));
      if (!isInside(root, resolvedAncestor)) {
        throw new Error(
          "Workspace action parent resolves outside the working directory",
        );
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor || !isInside(root, parent)) {
        throw new Error(
          "Workspace action parent resolves outside the working directory",
        );
      }
      existingAncestor = parent;
    }
  }
  try {
    const leaf = await checked(guard, lstat(candidate));
    if (leaf.isSymbolicLink()) {
      throw new Error("Browser workspace actions cannot write through symbolic links");
    }
    const resolved = await checked(guard, realpath(candidate));
    if (!isInside(root, resolved)) {
      throw new Error("Workspace action path resolves outside the working directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return candidate;
};

const resolveDeletionPath = async (
  root: string,
  value: string | undefined,
  guard: ActionGuard,
): Promise<string> => {
  if (value === undefined || value.length === 0) {
    throw new Error("Workspace action requires a path");
  }
  const candidate = lexicalPath(root, value, false);
  const resolvedParent = await checked(guard, realpath(path.dirname(candidate)));
  if (!isInside(root, resolvedParent)) {
    throw new Error("Workspace action parent resolves outside the working directory");
  }
  const leaf = await checked(guard, lstat(candidate));
  if (!leaf.isSymbolicLink()) {
    const resolved = await checked(guard, realpath(candidate));
    if (!isInside(root, resolved)) {
      throw new Error("Workspace action path resolves outside the working directory");
    }
  }
  return candidate;
};

const assertMutationPathStillSafe = async (
  root: string,
  candidate: string,
  guard: ActionGuard,
): Promise<void> => {
  assertActive(guard);
  const resolvedParent = await checked(guard, realpath(path.dirname(candidate)));
  if (!isInside(root, resolvedParent)) {
    throw new Error("Workspace mutation parent changed outside the working directory");
  }
  const leaf = await lstat(candidate).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error)
  );
  assertActive(guard);
  if (!leaf) {
    return;
  }
  if (leaf.isSymbolicLink()) {
    throw new Error("Workspace mutation target changed to a symbolic link");
  }
  const resolved = await checked(guard, realpath(candidate));
  if (!isInside(root, resolved)) {
    throw new Error("Workspace mutation target changed outside the working directory");
  }
};


type DeletionTargetIdentity = {
  dev: number;
  ino: number;
  mode: number;
  symbolicLink: boolean;
  directory: boolean;
  linkTarget?: string;
};

const deletionTargetIdentity = async (candidate: string): Promise<DeletionTargetIdentity> => {
  const value = await lstat(candidate);
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    symbolicLink: value.isSymbolicLink(),
    directory: value.isDirectory(),
    ...(value.isSymbolicLink() ? { linkTarget: await readlink(candidate) } : {}),
  };
};

const sameDeletionIdentity = (left: DeletionTargetIdentity, right: DeletionTargetIdentity): boolean =>
  left.symbolicLink === right.symbolicLink
  && left.directory === right.directory
  && left.mode === right.mode
  && (left.ino === 0 || right.ino === 0 || (left.dev === right.dev && left.ino === right.ino))
  && left.linkTarget === right.linkTarget;

const sha256File = async (candidate: string, guard: ActionGuard): Promise<string> => {
  const content = await checked(guard, readFile(candidate));
  return createHash("sha256").update(content).digest("hex");
};

const assertStagedFileHash = async (
  candidate: string,
  expectedSha256: string | undefined,
  guard: ActionGuard,
): Promise<void> => {
  if (!expectedSha256) return;
  if (await sha256File(candidate, guard) !== expectedSha256.toLowerCase()) {
    throw new Error("Workspace mutation target changed while it was being staged");
  }
};

const restoreStagedPathIfAbsent = async (staged: string, candidate: string): Promise<boolean> => {
  const current = await lstat(candidate).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error)
  );
  if (current) return false;
  await rename(staged, candidate);
  return true;
};

const assertPathAbsent = async (
  candidate: string,
  guard: ActionGuard,
  message: string,
): Promise<void> => {
  assertActive(guard);
  try {
    await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
};

const assertDeletionTargetStillSafe = async (
  root: string,
  candidate: string,
  expected: DeletionTargetIdentity,
  guard: ActionGuard,
): Promise<void> => {
  assertActive(guard);
  const resolvedParent = await checked(guard, realpath(path.dirname(candidate)));
  if (!isInside(root, resolvedParent)) {
    throw new Error("Workspace deletion parent changed outside the working directory");
  }
  const current = await checked(guard, deletionTargetIdentity(candidate));
  if (!sameDeletionIdentity(expected, current)) {
    throw new Error("Workspace deletion target changed after mutation preconditions were checked");
  }
  if (!current.symbolicLink) {
    const resolved = await checked(guard, realpath(candidate));
    if (!isInside(root, resolved)) {
      throw new Error("Workspace deletion target changed outside the working directory");
    }
  }
};

type CreatedDirectoryIdentity = {
  path: string;
  identity: DeletionTargetIdentity;
};

const ensureSafeParentDirectories = async (
  root: string,
  parent: string,
  guard: ActionGuard,
  createdDirectories?: CreatedDirectoryIdentity[],
): Promise<void> => {
  const missing: string[] = [];
  let cursor = parent;
  for (;;) {
    try {
      const info = await checked(guard, lstat(cursor));
      if (!info.isDirectory()) {
        throw new Error("Workspace mutation parent is not a directory");
      }
      const resolved = await checked(guard, realpath(cursor));
      if (!isInside(root, resolved)) {
        throw new Error("Workspace mutation parent resolves outside the working directory");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (cursor === root) {
        throw new Error("Workspace mutation root is missing");
      }
      missing.unshift(cursor);
      const next = path.dirname(cursor);
      if (next === cursor || !isInside(root, next)) {
        throw new Error("Workspace mutation parent escapes the working directory");
      }
      cursor = next;
    }
  }
  for (const directory of missing) {
    assertActive(guard);
    const resolvedParent = await checked(guard, realpath(path.dirname(directory)));
    if (!isInside(root, resolvedParent)) {
      throw new Error("Workspace mutation parent changed outside the working directory");
    }
    let created = false;
    try {
      await mkdir(directory);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await checked(guard, lstat(directory));
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Workspace mutation parent changed to a non-directory or symbolic link");
    }
    const resolved = await checked(guard, realpath(directory));
    if (!isInside(root, resolved)) {
      throw new Error("Workspace mutation parent changed outside the working directory");
    }
    if (created && createdDirectories) {
      createdDirectories.push({
        path: directory,
        identity: await checked(guard, deletionTargetIdentity(directory)),
      });
    }
  }
};

const safeRelative = (root: string, candidate: string): string =>
  path.relative(root, candidate).split(path.sep).join("/") || ".";

type BoundedText = {
  value: string;
  maximumBytes: number;
  truncated: boolean;
};

const createBoundedText = (maximumBytes: number): BoundedText => ({
  value: "",
  maximumBytes: Math.max(0, Math.floor(maximumBytes)),
  truncated: false,
});

const appendBoundedLine = (state: BoundedText, line: string): boolean => {
  if (state.truncated) {
    return false;
  }
  const addition = `${state.value ? "\n" : ""}${line}`;
  const candidate = `${state.value}${addition}`;
  if (Buffer.byteLength(candidate, "utf8") <= state.maximumBytes) {
    state.value = candidate;
    return true;
  }
  state.value = truncateUtf8Text(
    candidate,
    state.maximumBytes,
    "\n[output truncated]",
  );
  state.truncated = true;
  return false;
};

const isRestrictedWorkspacePath = (root: string, candidate: string): boolean => {
  try {
    return isPolicyRestrictedWorkspacePath(safeRelative(root, candidate));
  } catch {
    return true;
  }
};

const rejectRestrictedReadPath = (
  root: string,
  ...candidates: string[]
): void => {
  if (candidates.some((candidate) => isRestrictedWorkspacePath(root, candidate))) {
    throw new Error(
      "Browser workspace actions cannot inspect credential, VCS, dependency, or generated paths",
    );
  }
};

const shouldOmitListedEntry = (root: string, candidate: string): boolean =>
  isRestrictedWorkspacePath(root, candidate);

const listWorkspace = async (
  root: string,
  candidate: string,
  recursive: boolean,
  maximumEntries: number,
  maximumOutputBytes: number,
  guard: ActionGuard,
): Promise<string> => {
  const output = createBoundedText(maximumOutputBytes);
  let entriesSeen = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    assertActive(guard);
    const entries = await checked(
      guard,
      readdir(directory, { withFileTypes: true }),
    );
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertActive(guard);
      if (entriesSeen >= maximumEntries || output.truncated) {
        return;
      }
      const absolute = path.join(directory, entry.name);
      if (shouldOmitListedEntry(root, absolute)) {
        continue;
      }
      const relative = safeRelative(root, absolute);
      entriesSeen += 1;
      if (
        !appendBoundedLine(
          output,
          `${entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"}\t${relative}`,
        )
      ) {
        return;
      }
      if (recursive && entry.isDirectory() && depth < 8) {
        let resolved: string;
        try {
          resolved = await checked(guard, realpath(absolute));
        } catch {
          continue;
        }
        if (isInside(root, resolved)) {
          await visit(resolved, depth + 1);
        }
      }
    }
  };
  const candidateStat = await checked(guard, stat(candidate));
  if (candidateStat.isDirectory()) {
    await visit(candidate, 0);
  } else {
    entriesSeen = 1;
    appendBoundedLine(output, `file\t${safeRelative(root, candidate)}`);
  }
  if (entriesSeen >= maximumEntries && !output.truncated) {
    appendBoundedLine(
      output,
      `[truncated after ${String(maximumEntries)} entries]`,
    );
  }
  return output.value;
};

const readWorkspaceFile = async (
  root: string,
  candidate: string,
  maximumBytes: number,
  guard: ActionGuard,
): Promise<string> => {
  const value = await checked(guard, stat(candidate));
  if (!value.isFile()) {
    throw new Error("Workspace read target is not a file");
  }
  const handle = await checked(guard, open(candidate, "r"));
  try {
    const buffer = Buffer.alloc(
      Math.min(maximumBytes + 1, Math.max(1, value.size)),
    );
    const read = await checked(
      guard,
      handle.read(buffer, 0, buffer.length, 0),
    );
    const truncated = read.bytesRead > maximumBytes || value.size > maximumBytes;
    const text = truncateUtf8Text(
      buffer
        .subarray(0, Math.min(read.bytesRead, maximumBytes))
        .toString("utf8"),
      maximumBytes,
      "",
    );
    const complete = !truncated;
    const digest = complete ? createHash("sha256").update(buffer.subarray(0, read.bytesRead)).digest("hex") : undefined;
    return `${safeRelative(root, candidate)}${digest ? `\nsha256:${digest}` : ""}\n${text}${truncated ? `\n[truncated after ${String(maximumBytes)} bytes]` : ""}`;
  } finally {
    await handle.close();
  }
};

const searchableExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

const searchWorkspace = async (
  root: string,
  candidate: string,
  query: string,
  maximumResults: number,
  maximumReadBytes: number,
  maximumOutputBytes: number,
  guard: ActionGuard,
): Promise<string> => {
  const needle = query.toLocaleLowerCase();
  if (!needle) {
    throw new Error("Workspace search query cannot be empty");
  }
  const output = createBoundedText(maximumOutputBytes);
  let matches = 0;
  const visit = async (target: string): Promise<void> => {
    assertActive(guard);
    if (matches >= maximumResults || output.truncated) {
      return;
    }
    const value = await checked(guard, stat(target));
    if (value.isDirectory()) {
      const entries = await checked(
        guard,
        readdir(target, { withFileTypes: true }),
      );
      for (const entry of entries) {
        assertActive(guard);
        if (matches >= maximumResults || output.truncated) {
          return;
        }
        const absolute = path.join(target, entry.name);
        if (isRestrictedWorkspacePath(root, absolute)) {
          continue;
        }
        if (!entry.isDirectory() && !entry.isFile()) {
          continue;
        }
        let resolved: string;
        try {
          resolved = await checked(guard, realpath(absolute));
        } catch {
          continue;
        }
        if (
          isInside(root, resolved) &&
          !isRestrictedWorkspacePath(root, resolved)
        ) {
          await visit(resolved);
        }
      }
      return;
    }
    if (!value.isFile() || isRestrictedWorkspacePath(root, target)) {
      return;
    }
    const extension = path.extname(target).toLowerCase();
    if (extension && !searchableExtensions.has(extension) && value.size > 256_000) {
      return;
    }
    const bytes = Math.min(value.size, maximumReadBytes);
    const handle = await checked(guard, open(target, "r"));
    let text = "";
    try {
      const buffer = Buffer.alloc(Math.max(1, bytes));
      const read = await checked(
        guard,
        handle.read(buffer, 0, buffer.length, 0),
      );
      if (buffer.subarray(0, read.bytesRead).includes(0)) {
        return;
      }
      text = buffer.subarray(0, read.bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (const [index, line] of lines.entries()) {
      assertActive(guard);
      if (matches >= maximumResults || output.truncated) {
        return;
      }
      if (!line.toLocaleLowerCase().includes(needle)) {
        continue;
      }
      matches += 1;
      if (
        !appendBoundedLine(
          output,
          `${safeRelative(root, target)}:${String(index + 1)}:${line}`,
        )
      ) {
        return;
      }
    }
  };
  await visit(candidate);
  if (matches >= maximumResults && !output.truncated) {
    appendBoundedLine(
      output,
      `[truncated after ${String(maximumResults)} matches]`,
    );
  }
  return output.value || "No matches";
};

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

const runProcess = async (
  command: string,
  args: string[],
  options: BrowserActionExecutorOptions,
  stdin?: string,
  maximumOutputBytes = options.maxOutputBytes,
  processTimeoutMs = options.timeoutMs,
  reportedTimeoutMs = options.timeoutMs,
  workingDirectory = options.workingDirectory,
): Promise<ProcessResult> => {
  if (options.signal.aborted) {
    throw new Error("Browser action was interrupted");
  }
  const stdout = createBoundedBuffer(maximumOutputBytes);
  const stderr = createBoundedBuffer(maximumOutputBytes);
  const scope = spawnProcessScope(command, args, {
    cwd: workingDirectory,
    env: gitProcessEnvironment(workingDirectory),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    cleanupGraceMs: options.terminateGraceMs,
  });
  scope.child.stdout?.on("data", (chunk: Buffer) => appendBoundedBuffer(stdout, chunk));
  scope.child.stderr?.on("data", (chunk: Buffer) => appendBoundedBuffer(stderr, chunk));
  scope.child.stdout?.once("error", (error) => {
    appendBoundedBuffer(stderr, Buffer.from(error instanceof Error ? error.message : String(error), "utf8"));
  });
  scope.child.stderr?.once("error", (error) => {
    appendBoundedBuffer(stderr, Buffer.from(error instanceof Error ? error.message : String(error), "utf8"));
  });
  scope.child.stdin?.once("error", (error) => {
    appendBoundedBuffer(stderr, Buffer.from(error instanceof Error ? error.message : String(error), "utf8"));
  });
  scope.child.stdin?.end(stdin);

  let timedOut = false;
  let interrupted = false;
  let termination: Promise<boolean> | undefined;
  let settleTermination: ((value: { type: "termination"; cleanupConfirmed: boolean }) => void) | undefined;
  const terminationOutcome = new Promise<{ type: "termination"; cleanupConfirmed: boolean }>((resolve) => {
    settleTermination = resolve;
  });
  const terminate = (): Promise<boolean> => {
    if (!termination) {
      termination = scope.terminate(options.terminateGraceMs).catch(() => false);
      void termination.then(
        (cleanupConfirmed) => {
          settleTermination?.({ type: "termination", cleanupConfirmed });
        },
        () => {
          settleTermination?.({ type: "termination", cleanupConfirmed: false });
        },
      );
    }
    return termination;
  };
  const abort = (): void => {
    interrupted = true;
    void terminate();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) {
    abort();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, processTimeoutMs);
  const targetOutcome = scope.result.then((result) => ({ type: "target" as const, result }));
  let outcome: Awaited<typeof targetOutcome> | Awaited<typeof terminationOutcome>;
  try {
    outcome = await Promise.race([targetOutcome, terminationOutcome]);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  }

  const cleanupConfirmed = outcome.type === "target"
    ? outcome.result.cleanupConfirmed
    : outcome.cleanupConfirmed;
  if (interrupted) {
    throw new Error(
      cleanupConfirmed
        ? "Browser action was interrupted"
        : "Browser action was interrupted but process-scope cleanup could not be confirmed",
    );
  }
  if (timedOut) {
    throw new Error(
      cleanupConfirmed
        ? `Browser action timed out after ${String(reportedTimeoutMs)} ms`
        : `Browser action timed out after ${String(reportedTimeoutMs)} ms and process-scope cleanup could not be confirmed`,
    );
  }
  if (outcome.type === "termination") {
    throw new Error(
      cleanupConfirmed
        ? "Browser action process was terminated"
        : "Browser action process was terminated and process-scope cleanup could not be confirmed",
    );
  }
  if (!cleanupConfirmed) {
    throw new Error("Browser action process-scope cleanup could not be confirmed after exit");
  }
  if (outcome.result.error) {
    throw new Error(outcome.result.error);
  }
  return {
    stdout: boundedBufferText(stdout),
    stderr: boundedBufferText(stderr),
    exitCode: outcome.result.exitCode ?? -1,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
};

const parseGitNumstatPaths = (stdout: string): string[] => {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) {
      continue;
    }
    const match = /^[-0-9]+\t[-0-9]+\t([\s\S]*)$/u.exec(record);
    if (!match) {
      throw new Error("Git returned an invalid patch path list");
    }
    if (match[1]) {
      paths.push(match[1]);
      continue;
    }
    const source = fields[index + 1];
    const target = fields[index + 2];
    if (!source || !target) {
      throw new Error("Git returned an incomplete renamed path list");
    }
    paths.push(source, target);
    index += 2;
  }
  return paths;
};

const validatePatchPath = (root: string, value: string): void => {
  const segments = process.platform === "win32" ? value.split(/[\\/]/u) : value.split("/");
  const absolute = process.platform === "win32"
    ? path.win32.isAbsolute(value) || path.posix.isAbsolute(value)
    : path.posix.isAbsolute(value);
  if (
    !value ||
    value === "/dev/null" ||
    absolute ||
    segments.includes("..")
  ) {
    throw new Error("Patch contains an unsafe path");
  }
  const candidate = path.resolve(root, value);
  if (!isInside(root, candidate) || candidate === root) {
    throw new Error("Patch contains an unsafe path");
  }
};

const inspectPatchPaths = async (
  root: string,
  patch: string,
  options: BrowserActionExecutorOptions,
  guard: ActionGuard,
): Promise<string[]> => {
  if (!patch.trim()) {
    throw new Error("Patch is empty");
  }
  const patchBytes = Buffer.byteLength(patch, "utf8");
  const parserOutputBytes = Math.max(
    options.maxOutputBytes,
    Math.min(Math.max(65_536, patchBytes * 2 + 1_024), 8_388_608),
  );
  const parsed = await runProcess(
    "git",
    ["apply", "--numstat", "-z", "--whitespace=nowarn", "-"],
    options,
    patch,
    parserOutputBytes,
    remainingTimeoutMs(guard),
  );
  assertActive(guard);
  if (parsed.exitCode !== 0) {
    throw new Error(parsed.stderr.trim() || "Patch is invalid");
  }
  if (parsed.stdoutTruncated || parsed.stderrTruncated) {
    throw new Error("Patch path validation output exceeded its limit");
  }
  const paths = [...new Set(parseGitNumstatPaths(parsed.stdout))];
  if (paths.length === 0) {
    throw new Error("Patch contains no file paths");
  }
  for (const value of paths) {
    validatePatchPath(root, value);
  }
  return paths;
};

type PatchSnapshotState = {
  exists: boolean;
  content?: Buffer;
  mode?: number;
};

const samePatchSnapshotState = (left: PatchSnapshotState, right: PatchSnapshotState): boolean =>
  left.exists === right.exists
  && left.mode === right.mode
  && ((!left.content && !right.content) || Boolean(left.content && right.content && left.content.equals(right.content)));

const patchSnapshotOutputs = async (
  root: string,
  targetPaths: readonly string[],
  expectedByPath: ReadonlyMap<string, string>,
  patch: string,
  options: BrowserActionExecutorOptions,
  guard: ActionGuard,
): Promise<Map<string, { before: PatchSnapshotState; after: PatchSnapshotState }>> => {
  const snapshotRoot = await checked(guard, mkdtemp(path.join(tmpdir(), "bachata-workspace-patch-")));
  const beforeByPath = new Map<string, PatchSnapshotState>();
  try {
    for (const relative of targetPaths) {
      assertActive(guard);
      const source = path.resolve(root, relative);
      const target = path.resolve(snapshotRoot, relative);
      let info: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        info = await checked(guard, lstat(source));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!info) {
        beforeByPath.set(relative, { exists: false });
        continue;
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Patch snapshot source must be a regular file: ${relative}`);
      }
      const content = await checked(guard, readFile(source));
      const expected = expectedByPath.get(relative);
      if (expected && createHash("sha256").update(content).digest("hex") !== expected) {
        throw new Error(`Source hash changed before patch snapshot: ${relative}`);
      }
      await checked(guard, mkdir(path.dirname(target), { recursive: true }));
      await checked(guard, copyFile(source, target));
      await checked(guard, chmod(target, Number(info.mode) & 0o7777));
      beforeByPath.set(relative, { exists: true, content, mode: Number(info.mode) & 0o7777 });
    }

    const applied = await runProcess(
      "git",
      ["apply", "--whitespace=nowarn", "-"],
      options,
      patch,
      options.maxOutputBytes,
      remainingTimeoutMs(guard),
      options.timeoutMs,
      snapshotRoot,
    );
    assertActive(guard);
    if (applied.exitCode !== 0) {
      throw new Error(applied.stderr.trim() || "git apply failed against the preconditioned patch snapshot");
    }

    const result = new Map<string, { before: PatchSnapshotState; after: PatchSnapshotState }>();
    for (const relative of targetPaths) {
      const target = path.resolve(snapshotRoot, relative);
      let info: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        info = await checked(guard, lstat(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!info) {
        result.set(relative, { before: beforeByPath.get(relative) ?? { exists: false }, after: { exists: false } });
        continue;
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Patch result must be a regular file: ${relative}`);
      }
      result.set(relative, {
        before: beforeByPath.get(relative) ?? { exists: false },
        after: {
          exists: true,
          content: await checked(guard, readFile(target)),
          mode: Number(info.mode) & 0o7777,
        },
      });
    }
    return result;
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

const assertPatchTargetsAllowedAndPreconditioned = async (
  root: string,
  action: BrowserActionCandidate,
  rawTargets: readonly string[],
  context: MutationPolicyContext,
): Promise<string[]> => {
  const targetPaths: string[] = [];
  const targetSet = new Set<string>();
  for (const rawTarget of rawTargets) {
    const allowed = await assertWorkspacePathAllowed(root, rawTarget, {
      ...context,
      workspaceRoot: root,
    });
    if (!targetSet.has(allowed.relative)) {
      targetSet.add(allowed.relative);
      targetPaths.push(allowed.relative);
    }
  }

  const expectedByPath = new Map<string, string>();
  for (const expected of action.expectedFiles ?? []) {
    const allowed = await assertWorkspacePathAllowed(root, expected.path, {
      ...context,
      workspaceRoot: root,
    });
    if (!targetSet.has(allowed.relative)) {
      throw new Error(`Expected source hash is not part of the patch: ${expected.path}`);
    }
    if (expectedByPath.has(allowed.relative)) {
      throw new Error(`Duplicate expected source hash: ${expected.path}`);
    }
    expectedByPath.set(allowed.relative, expected.sha256.toLowerCase());
  }

  for (const relative of targetPaths) {
    const absolute = path.resolve(root, relative);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`Patch source cannot be a symbolic link: ${relative}`);
      }
      if (info.isDirectory()) {
        throw new Error(`Patch target cannot be a directory: ${relative}`);
      }
      if (!info.isFile()) {
        throw new Error(`Patch target must be a regular file: ${relative}`);
      }
      if (!expectedByPath.has(relative)) {
        throw new Error(`Existing file mutation requires an expected SHA-256 from workspace.read: ${relative}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (expectedByPath.has(relative)) {
          throw new Error(`Expected SHA-256 supplied for a new patch path: ${relative}`);
        }
        continue;
      }
      throw error;
    }
  }

  if (action.expectedFiles && action.expectedFiles.length > 0) {
    await assertExpectedFileHashes(root, action.expectedFiles, context);
  }
  return targetPaths;
};

const deletePath = async (
  root: string,
  candidate: string,
  recursive: boolean,
  guard: ActionGuard,
  beforeDelete?: () => Promise<void>,
  expectedSha256?: string,
): Promise<void> => {
  assertActive(guard);
  const identity = await checked(guard, deletionTargetIdentity(candidate));
  if (identity.symbolicLink || !identity.directory) {
    const staged = path.join(
      path.dirname(candidate),
      `.${path.basename(candidate)}.bachata-${randomUUID()}.delete`,
    );
    assertActive(guard);
    await beforeDelete?.();
    await assertDeletionTargetStillSafe(root, candidate, identity, guard);
    assertActive(guard);
    await rename(candidate, staged);
    let stagedPresent = true;
    try {
      const stagedIdentity = await checked(guard, deletionTargetIdentity(staged));
      if (!sameDeletionIdentity(identity, stagedIdentity)) {
        throw new Error("Workspace deletion target changed while it was being staged");
      }
      if (!identity.symbolicLink) await assertStagedFileHash(staged, expectedSha256, guard);
      await assertPathAbsent(candidate, guard, "Workspace deletion target was recreated while deletion was being committed");
      if (!identity.symbolicLink) await assertStagedFileHash(staged, expectedSha256, guard);
      assertActive(guard);
      await unlink(staged);
      stagedPresent = false;
      assertActive(guard);
      return;
    } catch (error) {
      if (stagedPresent) {
        const restored = await restoreStagedPathIfAbsent(staged, candidate).catch(() => false);
        if (restored) stagedPresent = false;
      }
      if (stagedPresent) {
        throw new AggregateError([error], `Workspace deletion conflict preserved staged content at ${path.basename(staged)}`);
      }
      throw error;
    }
  }
  if (!recursive) {
    assertActive(guard);
    await beforeDelete?.();
    await assertDeletionTargetStillSafe(root, candidate, identity, guard);
    assertActive(guard);
    await rmdir(candidate);
    assertActive(guard);
    return;
  }
  const entries = await checked(guard, readdir(candidate));
  for (const entry of entries) {
    await deletePath(root, path.join(candidate, entry), true, guard);
  }
  await assertDeletionTargetStillSafe(root, candidate, identity, guard);
  assertActive(guard);
  await rmdir(candidate);
  assertActive(guard);
};

const writeWorkspaceFile = async (
  root: string,
  candidate: string,
  content: string | Buffer,
  guard: ActionGuard,
  replaceExisting: boolean,
  beforeReplace?: () => Promise<void>,
  expectedSha256?: string,
  replacementMode?: number,
  createdDirectories?: CreatedDirectoryIdentity[],
): Promise<void> => {
  assertActive(guard);
  await ensureSafeParentDirectories(root, path.dirname(candidate), guard, createdDirectories);
  await assertMutationPathStillSafe(root, candidate, guard);
  assertActive(guard);
  const temporary = path.join(
    path.dirname(candidate),
    `.${path.basename(candidate)}.bachata-${randomUUID()}.tmp`,
  );
  let stagedOriginal: string | undefined;
  try {
    if (!replaceExisting) {
      // Create at the final mode. Writing first and narrowing afterwards leaves the content
      // readable at the default mode for the width of that window; six other writers in this
      // package already pass the mode to open(). 0o600 is the floor for a new file.
      const createMode = replacementMode === undefined ? 0o600 : replacementMode & 0o7777;
      if (Buffer.isBuffer(content)) await writeFile(temporary, content, { flag: "wx", mode: createMode });
      else await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: createMode });
      if (replacementMode !== undefined) await chmod(temporary, replacementMode & 0o7777);
      await assertMutationPathStillSafe(root, candidate, guard);
      assertActive(guard);
      try {
        await link(temporary, candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Workspace file appeared after mutation preconditions were checked");
        }
        throw error;
      }
      assertActive(guard);
      return;
    }
    const identity = await checked(guard, deletionTargetIdentity(candidate));
    if (identity.symbolicLink || identity.directory) {
      throw new Error("Workspace replacement target must be a regular file");
    }
    const existing = await checked(guard, lstat(candidate));
    const mode = existing.mode & 0o7777;
    // Replacing a 0600 file must not stage its content at the default mode first.
    const stagedMode = (replacementMode ?? mode) & 0o7777;
    if (Buffer.isBuffer(content)) await writeFile(temporary, content, { flag: "wx", mode: stagedMode });
    else await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: stagedMode });
    await chmod(temporary, replacementMode ?? mode);
    assertActive(guard);
    await beforeReplace?.();
    await assertDeletionTargetStillSafe(root, candidate, identity, guard);
    assertActive(guard);
    stagedOriginal = path.join(
      path.dirname(candidate),
      `.${path.basename(candidate)}.bachata-${randomUUID()}.previous`,
    );
    await rename(candidate, stagedOriginal);
    const stagedIdentity = await checked(guard, deletionTargetIdentity(stagedOriginal));
    if (!sameDeletionIdentity(identity, stagedIdentity)) {
      throw new Error("Workspace replacement target changed while it was being staged");
    }
    await assertStagedFileHash(stagedOriginal, expectedSha256, guard);
    await assertMutationPathStillSafe(root, candidate, guard);
    assertActive(guard);
    try {
      await link(temporary, candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Workspace file changed while the replacement was being published");
      }
      throw error;
    }
    const replacementIdentity = await checked(guard, deletionTargetIdentity(candidate));
    const temporaryIdentity = await checked(guard, deletionTargetIdentity(temporary));
    if (!sameDeletionIdentity(replacementIdentity, temporaryIdentity)) {
      throw new Error("Workspace replacement changed while it was being committed");
    }
    await assertStagedFileHash(candidate, createHash("sha256").update(content).digest("hex"), guard);
    await assertStagedFileHash(stagedOriginal, expectedSha256, guard);
    await rm(stagedOriginal, { force: true });
    stagedOriginal = undefined;
    assertActive(guard);
  } catch (error) {
    if (stagedOriginal) {
      const restored = await restoreStagedPathIfAbsent(stagedOriginal, candidate).catch(() => false);
      if (restored) stagedOriginal = undefined;
    }
    if (stagedOriginal) {
      throw new AggregateError([error], `Workspace replacement conflict preserved staged content at ${path.basename(stagedOriginal)}`);
    }
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const removeRolledBackDirectories = async (
  directories: readonly CreatedDirectoryIdentity[],
  guard: ActionGuard,
): Promise<void> => {
  const unique = new Map<string, CreatedDirectoryIdentity>();
  for (const directory of directories) {
    unique.set(directory.path, directory);
  }
  const ordered = [...unique.values()].sort((left, right) => right.path.length - left.path.length);
  for (const directory of ordered) {
    assertActive(guard);
    let current: DeletionTargetIdentity;
    try {
      current = await checked(guard, deletionTargetIdentity(directory.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!sameDeletionIdentity(directory.identity, current)) {
      throw new Error(`Patch rollback refused because a newly created directory changed concurrently: ${directory.path}`);
    }
    try {
      await rmdir(directory.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        throw new Error(`Patch rollback could not remove a newly created directory because it is no longer empty: ${directory.path}`);
      }
      throw error;
    }
  }
};

const currentPatchSnapshotState = async (
  candidate: string,
  guard: ActionGuard,
): Promise<PatchSnapshotState> => {
  let info: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    info = await checked(guard, lstat(candidate));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Patch rollback target is no longer a regular file: ${candidate}`);
  }
  return {
    exists: true,
    content: await checked(guard, readFile(candidate)),
    mode: Number(info.mode) & 0o7777,
  };
};

const restorePatchSnapshotState = async (
  root: string,
  relative: string,
  before: PatchSnapshotState,
  after: PatchSnapshotState,
  guard: ActionGuard,
): Promise<void> => {
  const candidate = path.resolve(root, relative);
  const current = await currentPatchSnapshotState(candidate, guard);
  if (samePatchSnapshotState(current, before)) {
    return;
  }
  if (!samePatchSnapshotState(current, after)) {
    throw new Error(`Patch rollback refused because the target changed concurrently: ${relative}`);
  }
  if (!before.exists) {
    if (!after.exists || !after.content) {
      return;
    }
    await deletePath(
      root,
      candidate,
      false,
      guard,
      undefined,
      createHash("sha256").update(after.content).digest("hex"),
    );
    return;
  }
  if (!before.content) {
    throw new Error(`Patch rollback snapshot is missing source content: ${relative}`);
  }
  if (!after.exists) {
    await writeWorkspaceFile(
      root,
      candidate,
      before.content,
      guard,
      false,
      undefined,
      undefined,
      before.mode,
    );
    return;
  }
  if (!after.content) {
    throw new Error(`Patch rollback snapshot is missing published content: ${relative}`);
  }
  await writeWorkspaceFile(
    root,
    candidate,
    before.content,
    guard,
    true,
    undefined,
    createHash("sha256").update(after.content).digest("hex"),
    before.mode,
  );
};

const result = (
  action: BrowserActionCandidate,
  startedAt: string,
  value: Omit<
    BrowserActionExecutionResult,
    "actionId" | "startedAt" | "completedAt"
  >,
): BrowserActionExecutionResult => ({
  actionId: action.id,
  startedAt,
  completedAt: new Date().toISOString(),
  ...value,
});

const expectedPathSet = (action: BrowserActionCandidate): Set<string> =>
  new Set((action.expectedFiles ?? []).map((entry) => normalizeWorkspaceRelativePath(entry.path)));

const expectedHashForPath = (action: BrowserActionCandidate, relative: string): string | undefined =>
  action.expectedFiles?.find((entry) => normalizeWorkspaceRelativePath(entry.path) === relative)?.sha256.toLowerCase();

const assertExistingMutationTargetsHavePreconditions = async (
  root: string,
  action: BrowserActionCandidate,
  context: MutationPolicyContext,
): Promise<void> => {
  if (!new Set(["workspace.write", "workspace.delete"]).has(action.kind)) return;
  if (action.kind === "workspace.delete" && action.recursive) {
    throw new Error("Recursive browser workspace deletion is disabled");
  }
  const targets = action.path ? [action.path] : [];
  const expected = expectedPathSet(action);
  for (const target of targets) {
    const allowed = await assertWorkspacePathAllowed(root, target, { ...context, workspaceRoot: root });
    try {
      const info = await lstat(path.resolve(root, allowed.relative));
      if (info.isDirectory()) {
        if (action.kind === "workspace.delete") throw new Error("Browser directory deletion is disabled");
        continue;
      }
      if (info.isFile() && !expected.has(allowed.relative)) {
        throw new Error(`Existing file mutation requires an expected SHA-256 from workspace.read: ${target}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
};

export const executeBrowserAction = async (
  action: BrowserActionCandidate,
  options: BrowserActionExecutorOptions,
): Promise<BrowserActionExecutionResult> => {
  const startedAt = new Date().toISOString();
  const guard = createGuard(options);
  let attemptedAffectedPaths: string[] | undefined;
  try {
    assertActive(guard);
    const root = await resolveRoot(options.workingDirectory, guard);
    const mutationContext: MutationPolicyContext = {
      ...deriveMutationContext(options),
      ...(options.mutationContext ?? {}),
      workspaceRoot: root,
    };
    assertWorkspaceActionAllowed(action, mutationContext);
    await assertWorkspaceActionPathsAllowed(action, mutationContext);
    if (action.kind === "shell.run") {
      throw new Error("Arbitrary shell actions are disabled; use structured workspace actions");
    }
    if (action.kind !== "workspace.applyPatch") {
      await assertExistingMutationTargetsHavePreconditions(root, action, mutationContext);
      assertActive(guard);
      if (action.expectedFiles && action.expectedFiles.length > 0) {
        await assertExpectedFileHashes(root, action.expectedFiles, mutationContext);
        assertActive(guard);
      }
    }
    if (action.kind === "workspace.list") {
      const candidate = await resolveExistingPath(root, action.path, guard);
      rejectRestrictedReadPath(root, candidate.lexical, candidate.resolved);
      const stdout = await listWorkspace(
        root,
        candidate.resolved,
        action.recursive ?? false,
        options.maxSearchResults,
        options.maxOutputBytes,
        guard,
      );
      return result(action, startedAt, {
        status: "completed",
        summary: describeBrowserAction(action),
        stdout,
        exitCode: 0,
      });
    }
    if (action.kind === "workspace.read") {
      const candidate = await resolveExistingPath(root, action.path, guard);
      rejectRestrictedReadPath(root, candidate.lexical, candidate.resolved);
      const stdout = await readWorkspaceFile(
        root,
        candidate.resolved,
        options.maxReadBytes,
        guard,
      );
      return result(action, startedAt, {
        status: "completed",
        summary: describeBrowserAction(action),
        stdout: truncateUtf8Text(stdout, options.maxOutputBytes),
        exitCode: 0,
      });
    }
    if (action.kind === "workspace.search") {
      const candidate = await resolveExistingPath(root, action.path, guard);
      rejectRestrictedReadPath(root, candidate.lexical, candidate.resolved);
      const stdout = await searchWorkspace(
        root,
        candidate.resolved,
        action.query ?? "",
        options.maxSearchResults,
        options.maxReadBytes,
        options.maxOutputBytes,
        guard,
      );
      return result(action, startedAt, {
        status: "completed",
        summary: describeBrowserAction(action),
        stdout,
        exitCode: 0,
      });
    }
    if (action.kind === "workspace.write") {
      const candidate = await resolveWritablePath(root, action.path, guard);
      const replaceExisting = action.path !== undefined
        && expectedPathSet(action).has(normalizeWorkspaceRelativePath(action.path));
      assertActive(guard);
      await writeWorkspaceFile(
        root,
        candidate,
        action.content ?? "",
        guard,
        replaceExisting,
        replaceExisting && action.expectedFiles
          ? async () => assertExpectedFileHashes(root, action.expectedFiles ?? [], mutationContext)
          : undefined,
        action.path ? expectedHashForPath(action, normalizeWorkspaceRelativePath(action.path)) : undefined,
      );
      return result(action, startedAt, {
        status: "completed",
        summary: `${describeBrowserAction(action)} (${String(Buffer.byteLength(action.content ?? "", "utf8"))} bytes)`,
        exitCode: 0,
      });
    }
    if (action.kind === "workspace.delete") {
      const candidate = await resolveDeletionPath(root, action.path, guard);
      assertActive(guard);
      await deletePath(
        root,
        candidate,
        action.recursive ?? false,
        guard,
        action.expectedFiles && action.expectedFiles.length > 0
          ? async () => assertExpectedFileHashes(root, action.expectedFiles ?? [], mutationContext)
          : undefined,
        action.path ? expectedHashForPath(action, normalizeWorkspaceRelativePath(action.path)) : undefined,
      );
      return result(action, startedAt, {
        status: "completed",
        summary: describeBrowserAction(action),
        exitCode: 0,
      });
    }
    if (action.kind === "workspace.applyPatch") {
      const patch = action.patch ?? "";
      const gitTargets = await inspectPatchPaths(root, patch, options, guard);
      const rawTargets = [...new Set([...gitTargets, ...extractPatchPaths(patch)])];
      const affectedPaths = await assertPatchTargetsAllowedAndPreconditioned(
        root,
        action,
        rawTargets,
        mutationContext,
      );
      attemptedAffectedPaths = [...affectedPaths];
      const expectedByPath = new Map(
        (action.expectedFiles ?? []).map((entry) => [
          normalizeWorkspaceRelativePath(entry.path),
          entry.sha256.toLowerCase(),
        ]),
      );
      assertActive(guard);
      const outputs = await patchSnapshotOutputs(
        root,
        affectedPaths,
        expectedByPath,
        patch,
        options,
        guard,
      );
      if (action.expectedFiles && action.expectedFiles.length > 0) {
        await assertExpectedFileHashes(root, action.expectedFiles, mutationContext);
        assertActive(guard);
      }
      const attemptedPublications: string[] = [];
      const publicationCreatedDirectories: CreatedDirectoryIdentity[] = [];
      try {
        for (const relative of affectedPaths) {
          const state = outputs.get(relative);
          if (!state || samePatchSnapshotState(state.before, state.after)) continue;
          attemptedPublications.push(relative);
          const candidate = path.resolve(root, relative);
          const expectedSha256 = expectedByPath.get(relative);
          const verifyCurrent = state.before.exists && expectedSha256
            ? async () => assertExpectedFileHashes(
                root,
                [{ path: relative, sha256: expectedSha256 }],
                mutationContext,
              )
            : undefined;
          if (!state.after.exists) {
            await deletePath(
              root,
              candidate,
              false,
              guard,
              verifyCurrent,
              expectedSha256,
            );
            continue;
          }
          await writeWorkspaceFile(
            root,
            candidate,
            state.after.content ?? Buffer.alloc(0),
            guard,
            state.before.exists,
            verifyCurrent,
            expectedSha256,
            state.after.mode,
            publicationCreatedDirectories,
          );
        }
      } catch (publicationError) {
        const rollbackGuard: ActionGuard = {
          signal: new AbortController().signal,
          timeoutMs: Math.max(options.timeoutMs, 30_000),
          deadline: Date.now() + Math.max(options.timeoutMs, 30_000),
        };
        const rollbackErrors: unknown[] = [];
        for (const relative of [...attemptedPublications].reverse()) {
          const state = outputs.get(relative);
          if (!state || samePatchSnapshotState(state.before, state.after)) continue;
          try {
            await restorePatchSnapshotState(root, relative, state.before, state.after, rollbackGuard);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        try {
          await removeRolledBackDirectories(publicationCreatedDirectories, rollbackGuard);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [publicationError, ...rollbackErrors],
            "Patch publication failed and rollback could not be completed safely",
          );
        }
        throw publicationError;
      }
      return result(action, startedAt, {
        status: "completed",
        summary: `${describeBrowserAction(action)} (${createHash("sha256").update(patch).digest("hex").slice(0, 12)})`,
        stdout: "",
        stderr: "",
        exitCode: 0,
        affectedPaths,
      });
    }
    throw new Error(`Unsupported browser action kind: ${action.kind}`);
  } catch (error) {
    return result(action, startedAt, {
      status: "failed",
      summary: describeBrowserAction(action),
      stderr: truncateUtf8Text(
        error instanceof Error ? error.message : String(error),
        options.maxOutputBytes,
      ),
      ...(attemptedAffectedPaths ? { affectedPaths: attemptedAffectedPaths } : {}),
    });
  }
};

export const rejectedBrowserActionResult = (
  action: BrowserActionCandidate,
  summary = "Rejected by user",
): BrowserActionExecutionResult => {
  const now = new Date().toISOString();
  return {
    actionId: action.id,
    status: "rejected",
    summary,
    startedAt: now,
    completedAt: now,
  };
};
