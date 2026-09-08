import * as path from "node:path";
import { lstat, readFile, realpath, stat } from "node:fs/promises";

import {
  appendBoundedBuffer,
  boundedBufferText,
  createBoundedBuffer,
} from "../process/boundedOutput";
import { ProcessScopeResult, spawnProcessScope } from "../process/processScope";
import { nodeProcessEnvironment } from "../process/commandInvocation";
import { gitProcessEnvironment, safeProcessEnvironment } from "../process/safeEnvironment";
import { humanOnlyE2ePlanRefusal, humanOnlyE2eRefusal } from "../process/humanOnlyE2e";
import { VerificationCheckResult } from "./types";
import {
  autonomousVerificationRefusal,
  MANAGED_PROJECT_CHECKS_COMMAND,
  MANAGED_WORKSPACE_INTEGRITY_COMMAND,
} from "./verificationPolicy";
import type { RepositoryVerifierAuthority } from "./verificationPolicy";
import {
  findVerifier,
  verifierDescriptorId,
  verifierOutcome,
  VERIFIER_REGISTRY_PATH,
} from "./verifierRegistry";
import type { VerifierDescriptor, VerifierRegistry } from "./verifierRegistry";
import { loadVerifierRegistry } from "./verifierRegistryStore";
import { verifierRegistryDigest } from "./verifierApproval";
import { isRestrictedWorkspacePath, normalizeWorkspaceRelativePath } from "../browser/mutationPolicy";

export type CommandExecutionOptions = {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  autonomous?: boolean;
  // Absent means refused. A repository-declared executable starts only where a human
  // approved this specific run.
  repositoryVerifiers?: RepositoryVerifierAuthority;
  // The descriptor set the human approved, as `verifierRegistryDigest` renders it. The registry
  // is read at execution time from the run's own worktree, so without this the authority says
  // only that some registry was once approved, not that it is this one.
  approvedVerifierRegistryDigest?: string;
};

export type CommandExecution = {
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  cleanupConfirmed: boolean;
  /**
   * EX-A5-R02. Whether the bound dropped anything. A caller reading prose can decide it has
   * enough; a caller parsing a machine-readable inventory cannot, because what was dropped is
   * exactly the part it would have acted on.
   */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

type ExecutionOutcome =
  | { type: "result"; result: ProcessScopeResult }
  | { type: "termination"; cleanupConfirmed: boolean };

const execute = async (
  executable: string,
  args: string[],
  options: CommandExecutionOptions,
  shell?: string,
): Promise<CommandExecution> => {
  if (options.signal?.aborted) {
    return {
      stdout: "",
      stderr: "Command cancelled",
      timedOut: false,
      cancelled: true,
      cleanupConfirmed: true,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  const stdout = createBoundedBuffer(options.maxOutputBytes);
  const stderr = createBoundedBuffer(options.maxOutputBytes);
  const scope = spawnProcessScope(executable, args, {
    cwd: options.cwd,
    env: options.environment ?? safeProcessEnvironment(options.cwd),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    cleanupGraceMs: 2_000,
    ...(shell === undefined ? {} : { shell }),
  });
  scope.child.stdout?.on("data", (chunk: Buffer) => appendBoundedBuffer(stdout, chunk));
  scope.child.stderr?.on("data", (chunk: Buffer) => appendBoundedBuffer(stderr, chunk));
  scope.child.stdout?.once("error", (error) => {
    appendBoundedBuffer(stderr, Buffer.from(error instanceof Error ? error.message : String(error), "utf8"));
  });
  scope.child.stderr?.once("error", (error) => {
    appendBoundedBuffer(stderr, Buffer.from(error instanceof Error ? error.message : String(error), "utf8"));
  });

  let timedOut = false;
  let cancelled = false;
  let termination: Promise<boolean> | undefined;
  let settleTermination: ((value: ExecutionOutcome) => void) | undefined;
  const terminationOutcome = new Promise<ExecutionOutcome>((resolve) => {
    settleTermination = resolve;
  });
  const terminate = (): Promise<boolean> => {
    if (!termination) {
      termination = scope.terminate(2_000).catch(() => false);
      void termination.then((cleanupConfirmed) => {
        settleTermination?.({ type: "termination", cleanupConfirmed });
      });
    }
    return termination;
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, options.timeoutMs);
  const abort = (): void => {
    cancelled = true;
    void terminate();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  let outcome: ExecutionOutcome;
  try {
    outcome = await Promise.race([
      scope.result.then((result): ExecutionOutcome => ({ type: "result", result })),
      terminationOutcome,
    ]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }

  const result = outcome.type === "result"
    ? outcome.result
    : { cleanupConfirmed: outcome.cleanupConfirmed };
  if (result.error) {
    appendBoundedBuffer(stderr, Buffer.from(result.error, "utf8"));
  }
  if (!result.cleanupConfirmed) {
    appendBoundedBuffer(stderr, Buffer.from("Process scope cleanup could not be confirmed", "utf8"));
  }
  return {
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    stdout: boundedBufferText(stdout),
    stderr: boundedBufferText(stderr),
    timedOut,
    cancelled,
    cleanupConfirmed: result.cleanupConfirmed,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
};

export const resolveCommandShell = (
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  if (platform !== "win32") {
    return "/bin/sh";
  }
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable or invalid");
  }
  return path.win32.join(path.win32.normalize(systemRoot), "System32", "cmd.exe");
};

export const runProcess = async (
  executable: string,
  args: string[],
  options: CommandExecutionOptions,
): Promise<CommandExecution> => execute(executable, args, options);

export const runCommand = async (
  command: string,
  options: CommandExecutionOptions,
): Promise<CommandExecution> => {
  return execute(command, [], options, resolveCommandShell());
};


const executionResult = (
  exitCode: number,
  stdout: string,
  stderr: string,
): CommandExecution => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
  cancelled: false,
  cleanupConfirmed: true,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const nullSeparated = (value: string): string[] =>
  value.split("\0").filter((entry) => entry.length > 0);

const gitExecutionOptions = (
  options: CommandExecutionOptions,
): CommandExecutionOptions => ({
  ...options,
  environment: gitProcessEnvironment(options.cwd, options.environment),
});

// A bounded read of a machine-readable inventory is not the inventory: the paths the bound
// dropped are exactly the ones the checks below would have inspected, so a truncated
// enumeration fails the check rather than certifying the files it never saw.
const truncatedEnumeration = (options: CommandExecutionOptions, kind: string): string =>
  `The ${kind} file list exceeded ${String(options.maxOutputBytes)} bytes, so the changed files could not be enumerated`;

const gitChangedFiles = async (options: CommandExecutionOptions): Promise<{ files: string[]; error?: string }> => {
  const tracked = await runProcess("git", ["diff", "--name-only", "-z", "HEAD", "--"], gitExecutionOptions(options));
  if (tracked.exitCode !== 0 || tracked.timedOut || tracked.cancelled || !tracked.cleanupConfirmed) {
    return { files: [], error: tracked.stderr || "Unable to enumerate tracked changes" };
  }
  if (tracked.stdoutTruncated) {
    return { files: [], error: truncatedEnumeration(options, "tracked") };
  }
  const untracked = await runProcess("git", ["ls-files", "--others", "--exclude-standard", "-z"], gitExecutionOptions(options));
  if (untracked.exitCode !== 0 || untracked.timedOut || untracked.cancelled || !untracked.cleanupConfirmed) {
    return { files: [], error: untracked.stderr || "Unable to enumerate untracked changes" };
  }
  if (untracked.stdoutTruncated) {
    return { files: [], error: truncatedEnumeration(options, "untracked") };
  }
  const files = [...new Set([...nullSeparated(tracked.stdout), ...nullSeparated(untracked.stdout)])]
    .map((entry) => entry.replaceAll("\\", "/"))
    .sort();
  return { files };
};

const workspaceIntegrityExecution = async (options: CommandExecutionOptions): Promise<CommandExecution> => {
  const probe = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], gitExecutionOptions(options));
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true" || !probe.cleanupConfirmed) {
    return executionResult(1, "", "Controller-owned workspace integrity requires a Git worktree");
  }
  const diff = await runProcess("git", ["diff", "--check", "HEAD", "--"], gitExecutionOptions(options));
  if (diff.exitCode !== 0 || diff.timedOut || diff.cancelled || !diff.cleanupConfirmed) return diff;
  const changed = await gitChangedFiles(options);
  if (changed.error) return executionResult(1, "", changed.error);
  if (changed.files.length > 10_000) {
    return executionResult(1, "", "Workspace integrity refused more than 10,000 changed files");
  }
  const canonicalWorkspaceRoot = await realpath(options.cwd);
  const failures: string[] = [];
  for (const relative of changed.files) {
    let normalized: string;
    try {
      normalized = normalizeWorkspaceRelativePath(relative);
    } catch {
      failures.push(`Invalid changed path: ${relative}`);
      continue;
    }
    if (isRestrictedWorkspacePath(normalized)) failures.push(`Restricted or generated output path: ${normalized}`);
    const absolute = path.resolve(options.cwd, normalized);
    const relation = path.relative(path.resolve(options.cwd), absolute);
    if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      failures.push(`Changed path escapes workspace: ${normalized}`);
      continue;
    }
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        failures.push(`Changed path is a symbolic link: ${normalized}`);
        continue;
      }
      if (!info.isFile() || info.size > 16 * 1024 * 1024) continue;
      const canonical = await realpath(absolute);
      const canonicalRelation = path.relative(canonicalWorkspaceRoot, canonical);
      if (canonicalRelation === ".." || canonicalRelation.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelation)) {
        failures.push(`Changed path resolves outside workspace: ${normalized}`);
        continue;
      }
      const content = await readFile(absolute);
      if (content.includes(0)) continue;
      const text = content.toString("utf8");
      if (/^(?:<{7}|={7}|>{7})/mu.test(text)) failures.push(`Conflict marker: ${normalized}`);
      if (/(?:[ \t]+\r?$)/mu.test(text)) failures.push(`Trailing whitespace: ${normalized}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        failures.push(`Unable to inspect ${normalized}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length >= 100) break;
  }
  return failures.length > 0
    ? executionResult(1, "", failures.join("\n"))
    : executionResult(0, `Workspace integrity passed for ${String(changed.files.length)} changed file(s)`, "");
};

const projectChecksExecution = async (options: CommandExecutionOptions): Promise<CommandExecution> => {
  const integrity = await workspaceIntegrityExecution(options);
  if (integrity.exitCode !== 0 || integrity.timedOut || integrity.cancelled || !integrity.cleanupConfirmed) return integrity;
  const changed = await gitChangedFiles(options);
  if (changed.error) return executionResult(1, "", changed.error);
  const failures: string[] = [];
  const summaries: string[] = [integrity.stdout];
  const existing: string[] = [];
  for (const relative of changed.files) {
    const absolute = path.resolve(options.cwd, relative);
    try {
      if ((await stat(absolute)).isFile()) existing.push(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const relative of existing.filter((entry) => /\.json$/iu.test(entry))) {
    try {
      JSON.parse(await readFile(path.resolve(options.cwd, relative), "utf8"));
    } catch (error) {
      failures.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const nodeOptions = { ...options, environment: nodeProcessEnvironment(options.environment ?? safeProcessEnvironment(options.cwd)) };
  const runBatches = async (label: string, executable: string, prefix: string[], files: string[], batchSize = 100, executionOptions = options): Promise<void> => {
    for (let offset = 0; offset < files.length; offset += batchSize) {
      const result = await runProcess(executable, [...prefix, ...files.slice(offset, offset + batchSize)], executionOptions);
      if (result.exitCode !== 0 || result.timedOut || result.cancelled || !result.cleanupConfirmed) {
        failures.push(`${label}: ${result.stderr || result.stdout || "failed"}`);
        break;
      }
    }
    if (files.length > 0 && failures.every((entry) => !entry.startsWith(`${label}:`))) {
      summaries.push(`${label} passed for ${String(files.length)} file(s)`);
    }
  };
  await runBatches("Node syntax", process.execPath, ["--check"], existing.filter((entry) => /\.(?:cjs|mjs|js)$/iu.test(entry)), 1, nodeOptions);
  await runBatches("Python syntax", "python3", ["-I", "-S", "-c", "import ast,pathlib,sys;[ast.parse(pathlib.Path(p).read_text(encoding='utf-8'),filename=p) for p in sys.argv[1:]]"], existing.filter((entry) => /\.pyi?$/iu.test(entry)));
  await runBatches("PHP syntax", "php", ["-n", "-l"], existing.filter((entry) => /\.php$/iu.test(entry)), 1);
  await runBatches("Shell syntax", "/bin/sh", ["-n"], existing.filter((entry) => /\.(?:bash|sh)$/iu.test(entry)), 1);
  await runBatches("Ruby syntax", "ruby", ["--disable-gems", "-c"], existing.filter((entry) => /\.rb$/iu.test(entry)), 1);
  const tsFiles = existing.filter((entry) => /\.[cm]?tsx?$/iu.test(entry));
  if (tsFiles.length > 0) {
    const workspaceRoot = await realpath(path.resolve(options.cwd)).catch(() => path.resolve(options.cwd));
    const nearestProject = async (relative: string): Promise<string | undefined> => {
      let cursor = path.dirname(path.resolve(workspaceRoot, relative));
      while (true) {
        for (const name of ["tsconfig.json", "jsconfig.json"]) {
          const candidate = path.join(cursor, name);
          try {
            const info = await lstat(candidate);
            if (info.isSymbolicLink() || !info.isFile()) continue;
            const canonical = await realpath(candidate);
            const relation = path.relative(workspaceRoot, canonical);
            if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) continue;
            return canonical;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (cursor === workspaceRoot) return undefined;
        const parent = path.dirname(cursor);
        if (parent === cursor || !parent.startsWith(workspaceRoot)) return undefined;
        cursor = parent;
      }
    };
    const projects = new Map<string, string[]>();
    for (const relative of tsFiles) {
      const project = await nearestProject(relative);
      const key = project ?? "<no-project>";
      const values = projects.get(key) ?? [];
      values.push(relative);
      projects.set(key, values);
    }
    if (projects.size > 64) {
      failures.push(`TypeScript project checks refused ${String(projects.size)} project roots`);
    } else {
      for (const [project, files] of projects) {
        let compiler: string;
        try {
          compiler = require.resolve("typescript/bin/tsc");
        } catch {
          failures.push(`${project}: Bachata's pinned TypeScript compiler is unavailable`);
          continue;
        }
        const args = ["--max-old-space-size=2048", compiler];
        if (project === "<no-project>") {
          args.push("--noEmit", "--pretty", "false", "--incremental", "false", "--skipLibCheck", ...files);
        } else {
          args.push("--project", project, "--noEmit", "--pretty", "false", "--incremental", "false");
        }
        const result = await runProcess(process.execPath, args, nodeOptions);
        if (result.exitCode !== 0 || result.timedOut || result.cancelled || !result.cleanupConfirmed) {
          failures.push(`TypeScript project check (${project}): ${result.stderr || result.stdout || "failed"}`);
        } else {
          summaries.push(`TypeScript project check passed for ${project === "<no-project>" ? String(files.length) + " unconfigured file(s)" : path.relative(workspaceRoot, project)}`);
        }
      }
    }
  }
  return failures.length > 0
    ? executionResult(1, summaries.filter(Boolean).join("\n"), failures.slice(0, 100).join("\n"))
    : executionResult(0, summaries.filter(Boolean).join("\n"), "");
};

export const verifierWorkingDirectory = (
  descriptor: VerifierDescriptor,
  cwd: string,
): string =>
  descriptor.workingDirectory.length > 0
    ? path.join(cwd, ...descriptor.workingDirectory.split("/"))
    : cwd;

const runRepositoryVerifier = async (
  descriptor: VerifierDescriptor,
  options: CommandExecutionOptions,
  cwd: string,
): Promise<CommandExecution> => {
  // Rechecked immediately before the spawn: the package scripts a descriptor's command
  // resolves through can be rewritten between planning this run and starting it.
  const spawnRefusal = await humanOnlyE2ePlanRefusal({
    executable: descriptor.executable,
    args: descriptor.args,
    cwd,
  });
  if (spawnRefusal !== undefined) return executionResult(1, "", spawnRefusal);
  const allowlisted = Object.fromEntries(
    descriptor.environmentAllowlist
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  const execution = await execute(descriptor.executable, descriptor.args, {
    ...options,
    cwd,
    timeoutMs: Math.min(options.timeoutMs, descriptor.timeoutMs),
    maxOutputBytes: Math.min(options.maxOutputBytes, descriptor.maxOutputBytes),
    environment: safeProcessEnvironment(cwd, allowlisted),
  });
  if (execution.timedOut || execution.cancelled) return execution;
  const outcome = verifierOutcome(descriptor, execution);
  return outcome.passed
    ? { ...execution, exitCode: 0 }
    : {
        ...execution,
        exitCode: execution.exitCode === 0 ? 1 : execution.exitCode ?? 1,
        stderr: [execution.stderr, outcome.reason].filter(Boolean).join("\n"),
      };
};

/*
 * One resolved plan is classified, then executed. The symbolic `bachata:verifier:<id>` string
 * names a descriptor but carries none of its executable, so policy that reads the symbol
 * alone cannot see what will run. Nothing between the classification and the spawn may
 * re-resolve the command.
 */
type VerificationPlan =
  | { kind: "builtin"; command: string }
  | { kind: "verifier"; command: string; descriptor: VerifierDescriptor; cwd: string }
  | { kind: "shell"; command: string; cwd: string }
  | { kind: "refused"; command: string; reason: string };

export const repositoryVerifierAuthority = (
  options: CommandExecutionOptions,
): RepositoryVerifierAuthority => options.repositoryVerifiers ?? "refused";

const resolveVerificationPlan = (
  command: string,
  options: CommandExecutionOptions,
  registry?: VerifierRegistry,
): VerificationPlan => {
  if (options.autonomous !== true) return { kind: "shell", command, cwd: options.cwd };
  if (command === MANAGED_WORKSPACE_INTEGRITY_COMMAND || command === MANAGED_PROJECT_CHECKS_COMMAND) {
    return { kind: "builtin", command };
  }
  const refusal = autonomousVerificationRefusal(
    command,
    registry,
    repositoryVerifierAuthority(options),
  );
  if (refusal !== undefined) return { kind: "refused", command, reason: refusal };
  const descriptor = findVerifier(registry, command);
  if (descriptor) {
    return {
      kind: "verifier",
      command,
      descriptor,
      cwd: verifierWorkingDirectory(descriptor, options.cwd),
    };
  }
  return { kind: "refused", command, reason: `Unsupported verification command: ${command}` };
};

const humanOnlyPlanRefusal = async (
  plan: VerificationPlan,
): Promise<string | undefined> => {
  if (plan.kind === "verifier") {
    return humanOnlyE2ePlanRefusal({
      executable: plan.descriptor.executable,
      args: plan.descriptor.args,
      cwd: plan.cwd,
    });
  }
  if (plan.kind === "shell") return humanOnlyE2eRefusal(plan.command, plan.cwd);
  // Built-in controller checks spawn fixed integrity, syntax and type tooling that no
  // repository declaration can redirect, and a refused plan never reaches a spawn.
  return undefined;
};

const executeVerificationPlan = async (
  plan: VerificationPlan,
  options: CommandExecutionOptions,
): Promise<CommandExecution> => {
  if (plan.kind === "builtin") {
    return plan.command === MANAGED_WORKSPACE_INTEGRITY_COMMAND
      ? workspaceIntegrityExecution(options)
      : projectChecksExecution(options);
  }
  if (plan.kind === "verifier") return runRepositoryVerifier(plan.descriptor, options, plan.cwd);
  if (plan.kind === "shell") return runCommand(plan.command, options);
  return executionResult(1, "", plan.reason);
};

export const runVerificationChecks = async (
  commands: string[],
  options: CommandExecutionOptions,
): Promise<VerificationCheckResult[]> => {
  const results: VerificationCheckResult[] = [];
  let registry: VerifierRegistry | undefined;
  let registryErrors: string[] = [];
  // With no human-approved authority no descriptor will be executed, so the registry is
  // not read and the refusal states the boundary rather than a registry defect.
  if (options.autonomous
    && repositoryVerifierAuthority(options) === "humanApproved"
    && commands.some((command) => verifierDescriptorId(command.trim()) !== undefined)) {
    const load = await loadVerifierRegistry(options.cwd);
    registry = load.registry;
    registryErrors = load.present
      ? load.errors
      : [`${VERIFIER_REGISTRY_PATH} does not exist in this repository`];
    const approvedDigest = options.approvedVerifierRegistryDigest;
    if (registry && approvedDigest !== undefined && verifierRegistryDigest(registry) !== approvedDigest) {
      registry = undefined;
      registryErrors = [
        `${VERIFIER_REGISTRY_PATH} declares a different set of checks from the one that was approved`,
      ];
    }
  }
  for (const command of commands) {
    const startedAt = new Date().toISOString();
    const registryRefusal = options.autonomous &&
      repositoryVerifierAuthority(options) === "humanApproved" &&
      verifierDescriptorId(command.trim()) !== undefined &&
      registryErrors.length > 0
      ? `Repository verifier registry rejected: ${registryErrors.join("; ")}`
      : undefined;
    const autonomousRefusal = registryRefusal ??
      (options.autonomous
        ? autonomousVerificationRefusal(command, registry, repositoryVerifierAuthority(options))
        : undefined);
    const plan = autonomousRefusal === undefined
      ? resolveVerificationPlan(command, options, registry)
      : undefined;
    const refusal = autonomousRefusal ??
      (plan === undefined ? undefined : await humanOnlyPlanRefusal(plan));
    if (refusal) {
      const completedAt = new Date().toISOString();
      results.push({
        command,
        status: "failed",
        stderr: refusal,
        stdout: "",
        startedAt,
        completedAt,
        cleanupConfirmed: true,
      });
      break;
    }
    const execution = plan === undefined
      ? executionResult(1, "", `Unsupported verification command: ${command}`)
      : await executeVerificationPlan(plan, options);
    const completedAt = new Date().toISOString();
    const status = execution.cancelled
      ? "cancelled"
      : execution.timedOut
        ? "timedOut"
        : execution.exitCode === 0 && execution.cleanupConfirmed
          ? "passed"
          : "failed";
    results.push({
      command,
      status,
      ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
      stdout: execution.stdout,
      stderr: execution.stderr,
      startedAt,
      completedAt,
      cleanupConfirmed: execution.cleanupConfirmed,
    });
    if (status !== "passed") {
      break;
    }
  }
  return results;
};
