import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";

export type CommitMode = "never" | "allow";
export type WorkspaceScopeMode = "workspace" | "bounded";
export type MutationPolicyErrorCode =
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_OUTSIDE_SCOPE"
  | "RESTRICTED_PATH"
  | "READ_ONLY"
  | "GIT_MUTATION"
  | "STALE_FILE"
  | "POLICY_VIOLATION";

export type MutationPolicyContext = {
  workspaceRoot?: string;
  allowedPaths?: string[];
  restrictedPaths?: string[];
  commitMode?: CommitMode;
  readOnly?: boolean;
  scopeMode?: WorkspaceScopeMode;
};

export class MutationPolicyError extends Error {
  readonly code: MutationPolicyErrorCode;

  constructor(message: string, code: MutationPolicyErrorCode = "POLICY_VIOLATION") {
    super(message);
    this.name = "MutationPolicyError";
    this.code = code;
  }
}

const DEFAULT_RESTRICTED_NAMES = new Set([
  ".bachata",
  ".git",
  ".hg",
  ".svn",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "secrets",
  "secrets.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

const DEFAULT_RESTRICTED_FILE_PATTERNS = [
  /^\.env(?!(?:\.example)$)(?:\.|$)/i,
  /^\.(?:npmrc|yarnrc|pypirc|netrc)$/i,
  /^\.git-credentials$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  /^(?:credentials|application_default_credentials|service[-_]account)\.json$/i,
  /^secrets?\.(?:json|ya?ml|toml)$/i,
];

const normalizeSlashes = (value: string): string =>
  process.platform === "win32" ? value.replace(/\\/g, "/") : value;

export const normalizeWorkspaceRelativePath = (value: string): string => {
  if (value.includes("\0")) {
    throw new MutationPolicyError("Path contains a null byte", "INVALID_PATH");
  }
  const normalizedInput = normalizeSlashes(value);
  if (normalizedInput.length === 0 || normalizedInput === ".") {
    return ".";
  }
  if (normalizedInput.startsWith("/")
    || /^[a-z]:\//i.test(normalizedInput)
    || normalizedInput.startsWith("//")) {
    throw new MutationPolicyError(`Absolute path is not allowed: ${value}`, "PATH_OUTSIDE_WORKSPACE");
  }
  const normalized = path.posix.normalize(normalizedInput).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new MutationPolicyError(`Path escapes the workspace: ${value}`, "PATH_OUTSIDE_WORKSPACE");
  }
  return normalized;
};

const pathSegments = (value: string): string[] =>
  normalizeWorkspaceRelativePath(value).split("/").filter(Boolean).map((segment) => segment.toLowerCase());

const matchesPrefix = (value: string, prefix: string): boolean => {
  const normalizedValue = normalizeWorkspaceRelativePath(value).toLowerCase();
  const normalizedPrefix = normalizeWorkspaceRelativePath(prefix).replace(/\/+$/, "").toLowerCase();
  if (normalizedPrefix === ".") {
    return true;
  }
  return normalizedValue === normalizedPrefix || normalizedValue.startsWith(`${normalizedPrefix}/`);
};

export const isRestrictedWorkspacePath = (
  value: string,
  restrictedPaths: readonly string[] = [],
): boolean => {
  const normalized = normalizeWorkspaceRelativePath(value);
  const segments = pathSegments(normalized);
  if (segments.some((segment) => DEFAULT_RESTRICTED_NAMES.has(segment))) {
    return true;
  }
  if (segments.some((segment) => DEFAULT_RESTRICTED_FILE_PATTERNS.some((pattern) => pattern.test(segment)))) {
    return true;
  }
  return restrictedPaths.some((entry) => matchesPrefix(normalized, entry));
};

const DISCLOSED_READ_EXCLUSION_NAMES = new Set([
  ".bachata",
  ".git",
  ".hg",
  ".svn",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
]);

export const isDisclosedReadExclusion = (
  value: string,
  restrictedPaths: readonly string[] = [],
): boolean => {
  const normalized = normalizeWorkspaceRelativePath(value);
  const segments = pathSegments(normalized);
  if (segments.some((segment) => DISCLOSED_READ_EXCLUSION_NAMES.has(segment))) {
    return true;
  }
  if (segments.some((segment) => DEFAULT_RESTRICTED_FILE_PATTERNS.some((pattern) => pattern.test(segment)))) {
    return true;
  }
  return restrictedPaths.some((entry) => matchesPrefix(normalized, entry));
};

export const isAllowedWorkspacePath = (
  value: string,
  allowedPaths: readonly string[] = [],
  scopeMode: WorkspaceScopeMode = "workspace",
): boolean => {
  if (allowedPaths.length === 0) {
    return scopeMode === "workspace";
  }
  return allowedPaths.some((entry) => matchesPrefix(value, entry));
};

const absoluteInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

type CanonicalWorkspacePath = {
  lexicalRelative: string;
  resolvedRelative: string;
  resolvedAbsolute: string;
  rootReal: string;
};

const projectedCanonicalPath = async (
  workspaceRoot: string,
  value: string,
): Promise<CanonicalWorkspacePath> => {
  const lexicalRelative = normalizeWorkspaceRelativePath(value);
  const rootLexical = path.resolve(workspaceRoot);
  const rootReal = await fs.realpath(rootLexical);
  const lexical = path.resolve(rootLexical, lexicalRelative);
  if (!absoluteInside(rootLexical, lexical)) {
    throw new MutationPolicyError(`Path escapes the workspace: ${value}`, "PATH_OUTSIDE_WORKSPACE");
  }

  let existing = lexical;
  const tail: string[] = [];
  let resolvedAncestor: string | undefined;
  for (;;) {
    try {
      await fs.lstat(existing);
      resolvedAncestor = await fs.realpath(existing);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      if (existing === rootLexical) {
        resolvedAncestor = rootReal;
        break;
      }
      tail.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing || !absoluteInside(rootLexical, parent)) {
        throw new MutationPolicyError(`Path escapes the workspace: ${value}`, "PATH_OUTSIDE_WORKSPACE");
      }
      existing = parent;
    }
  }
  if (!resolvedAncestor || !absoluteInside(rootReal, resolvedAncestor)) {
    throw new MutationPolicyError(`Path resolves outside the workspace: ${value}`, "PATH_OUTSIDE_WORKSPACE");
  }
  const resolvedAbsolute = path.join(resolvedAncestor, ...tail);
  if (!absoluteInside(rootReal, resolvedAbsolute)) {
    throw new MutationPolicyError(`Path resolves outside the workspace: ${value}`, "PATH_OUTSIDE_WORKSPACE");
  }
  const resolvedRelativeNative = path.relative(rootReal, resolvedAbsolute);
  const resolvedRelative = normalizeWorkspaceRelativePath(
    resolvedRelativeNative ? resolvedRelativeNative.split(path.sep).join("/") : ".",
  );
  return { lexicalRelative, resolvedRelative, resolvedAbsolute, rootReal };
};

type CanonicalPolicyScope = {
  absolute: string;
  kind: "file" | "directory" | "missing";
};

const canonicalPolicyScopes = async (
  workspaceRoot: string,
  paths: readonly string[],
): Promise<CanonicalPolicyScope[]> => {
  const scopes: CanonicalPolicyScope[] = [];
  for (const entry of paths) {
    const directoryHint = /[\\/]$/u.test(entry.trim());
    const resolved = await projectedCanonicalPath(workspaceRoot, entry);
    let kind: CanonicalPolicyScope["kind"] = directoryHint ? "directory" : "missing";
    try {
      const info = await fs.stat(resolved.resolvedAbsolute);
      kind = info.isDirectory() ? "directory" : "file";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    scopes.push({ absolute: resolved.resolvedAbsolute, kind });
  }
  return scopes;
};

const matchesCanonicalScope = (scope: CanonicalPolicyScope, candidate: string): boolean =>
  scope.kind === "directory"
    ? absoluteInside(scope.absolute, candidate)
    : path.resolve(scope.absolute) === path.resolve(candidate);

export const assertWorkspacePathAllowed = async (
  workspaceRoot: string,
  value: string,
  context: MutationPolicyContext = {},
): Promise<{ relative: string; resolvedRelative: string; absolute: string }> => {
  const resolved = await projectedCanonicalPath(workspaceRoot, value);
  if (isRestrictedWorkspacePath(resolved.lexicalRelative, context.restrictedPaths)) {
    throw new MutationPolicyError(`Restricted path is not allowed: ${value}`, "RESTRICTED_PATH");
  }
  if (!isAllowedWorkspacePath(resolved.lexicalRelative, context.allowedPaths, context.scopeMode)) {
    throw new MutationPolicyError(`Path is outside the task scope: ${value}`, "PATH_OUTSIDE_SCOPE");
  }
  if (isRestrictedWorkspacePath(resolved.resolvedRelative, context.restrictedPaths)) {
    throw new MutationPolicyError(`Resolved path is restricted: ${value}`, "RESTRICTED_PATH");
  }

  const allowedEntries = context.allowedPaths ?? [];
  if (allowedEntries.length > 0) {
    const allowedScopes = await canonicalPolicyScopes(workspaceRoot, allowedEntries);
    if (!allowedScopes.some((scope) => matchesCanonicalScope(scope, resolved.resolvedAbsolute))) {
      throw new MutationPolicyError(`Resolved path is outside the task scope: ${value}`, "PATH_OUTSIDE_SCOPE");
    }
  }

  const restrictedScopes = await canonicalPolicyScopes(workspaceRoot, context.restrictedPaths ?? []);
  if (restrictedScopes.some((scope) =>
    scope.kind === "directory"
      ? absoluteInside(scope.absolute, resolved.resolvedAbsolute)
      : path.resolve(scope.absolute) === path.resolve(resolved.resolvedAbsolute)
  )) {
    throw new MutationPolicyError(`Resolved path is restricted: ${value}`, "RESTRICTED_PATH");
  }

  return {
    relative: resolved.lexicalRelative,
    resolvedRelative: resolved.resolvedRelative,
    absolute: resolved.resolvedAbsolute,
  };
};

export const MAX_READABLE_ROOTS = 1024;

type ReadableExpansion = { clean: boolean; roots: string[] };

type ReadableRootBudget = { limit: number; used: number };

const readableRootBudgetExceeded = (limit: number): MutationPolicyError =>
  new MutationPolicyError(
    `This workspace expands past the ${String(limit)} readable-root limit. Declare explicit read paths for this run.`,
    "POLICY_VIOLATION",
  );

// The budget counts roots this run will actually keep, and it is claimed at the moment a
// directory turns out unclean, which is when its retained roots are final. A workspace
// that cannot be expressed within the limit therefore stops the traversal at that
// directory instead of enumerating the rest of the tree first, and a clean subtree of any
// size still costs the single root it collapses to.
const claimReadableRoots = (budget: ReadableRootBudget, count: number): void => {
  budget.used += count;
  if (budget.used > budget.limit) {
    throw readableRootBudgetExceeded(budget.limit);
  }
};

const releaseReadableRoots = (budget: ReadableRootBudget, count: number): void => {
  budget.used -= count;
};

const expandReadableRoots = async (
  rootReal: string,
  directoryAbsolute: string,
  restrictedPaths: readonly string[],
  budget: ReadableRootBudget,
): Promise<ReadableExpansion> => {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directoryAbsolute, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { clean: false, roots: [] };
    }
    throw new MutationPolicyError(
      `Cannot enumerate ${directoryAbsolute} to resolve readable roots: ${code ?? "unknown error"}`,
      "POLICY_VIOLATION",
    );
  }
  const named = entries.map((entry) => {
    const absolute = path.join(directoryAbsolute, entry.name);
    const relative = path.relative(rootReal, absolute).split(path.sep).join("/");
    return { entry, absolute, relative };
  });
  // Cleanliness is decided from the directory listing before anything is descended into.
  // A directory that already holds an exclusion, a symbolic link or an irregular entry can
  // never collapse to a single root, so its own files are charged to the budget as they
  // are kept — the limit is then reached at the file that exceeds it, not after a sibling
  // subtree has been walked or has failed to open.
  let clean = !named.some(({ entry, relative }) =>
    isDisclosedReadExclusion(relative, restrictedPaths)
    || entry.isSymbolicLink()
    || !(entry.isDirectory() || entry.isFile()));
  const roots: string[] = [];
  // Roots this directory retains that no descendant has claimed yet. While the directory
  // may still collapse they stay pending, because a clean collapse costs one root however
  // many entries it holds.
  let pending = 0;
  const retain = (root: string): void => {
    roots.push(root);
    if (clean) {
      pending += 1;
      return;
    }
    claimReadableRoots(budget, 1);
  };
  const settleUnclean = (): void => {
    if (!clean) return;
    clean = false;
    claimReadableRoots(budget, pending);
    pending = 0;
  };
  const kept = named.filter(({ entry, relative }) =>
    !isDisclosedReadExclusion(relative, restrictedPaths) && !entry.isSymbolicLink());
  // Files first, so an over-budget directory is refused by its own contents before any
  // subdirectory is opened. Descending first would report whatever that subtree fails on.
  for (const { entry, absolute } of kept) {
    if (entry.isFile()) retain(absolute);
  }
  for (const { entry, absolute } of kept) {
    if (!entry.isDirectory()) continue;
    const expansion = await expandReadableRoots(rootReal, absolute, restrictedPaths, budget);
    if (!expansion.clean) {
      // The child charged its own roots; this directory can no longer collapse.
      settleUnclean();
      roots.push(...expansion.roots);
      continue;
    }
    expansion.roots.forEach(retain);
  }
  if (clean) {
    return { clean: true, roots: [directoryAbsolute] };
  }
  return { clean: false, roots };
};

// Bachata's own resolution of a narrowed read scope. No shipped provider honours it today: the
// Codex app-server protocol has no per-path readable-root capability, so a Codex run is
// refused rather than handed a payload it cannot keep (src/adapters/codexWire.ts), and Claude
// Code is bounded by tool-use validation instead. It is kept because it is the exact meaning
// of Bachata's read exclusions, and because a provider that gains the capability must be given
// this set rather than a fresh interpretation of it.
export const resolveReadableWorkspaceRoots = async (
  workspaceRoot: string,
  restrictedPaths: readonly string[] = [],
  targets: readonly string[] = [],
): Promise<string[]> => {
  const rootReal = await fs.realpath(path.resolve(workspaceRoot));
  const resolvedTargets = targets.length > 0 ? targets : [rootReal];
  const budget: ReadableRootBudget = { limit: MAX_READABLE_ROOTS, used: 0 };
  const claimed = new Set<string>();
  const roots: string[] = [];
  const keep = (entry: string): void => {
    if (claimed.has(entry)) {
      releaseReadableRoots(budget, 1);
      return;
    }
    claimed.add(entry);
    roots.push(entry);
  };
  for (const target of resolvedTargets) {
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      info = await fs.lstat(target);
    } catch (error) {
      throw new MutationPolicyError(
        `Declared read path cannot be resolved: ${target} (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
        "POLICY_VIOLATION",
      );
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      const expansion = await expandReadableRoots(rootReal, target, restrictedPaths, budget);
      // A clean target collapsed to one root that no directory below it claimed.
      if (expansion.clean) claimReadableRoots(budget, expansion.roots.length);
      expansion.roots.forEach(keep);
      continue;
    }
    claimReadableRoots(budget, 1);
    keep(target);
  }
  return roots;
};

export const assertWorkspaceActionPathsAllowed = async (
  action: unknown,
  context: MutationPolicyContext = {},
): Promise<void> => {
  if (!context.workspaceRoot) {
    throw new MutationPolicyError("Workspace root is required for canonical path policy checks");
  }
  for (const candidate of collectMutationPaths(action)) {
    await assertWorkspacePathAllowed(context.workspaceRoot, candidate, context);
  }
};

const shellTokens = (command: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (";&|()".includes(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      tokens.push(char);
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
};

const executableName = (token: string): string => {
  const basename = path.posix.basename(token.replace(/\\/g, "/")).toLowerCase();
  for (const name of ["cmd", "powershell", "pwsh", "sh", "bash", "zsh", "dash", "ksh", "fish", "git", "env", "command", "builtin", "exec", "sudo", "eval"]) {
    if (basename === name || basename === `${name}.exe` || basename.endsWith(`${name}.exe`)) {
      return name;
    }
  }
  return basename;
};

// Bash options that take a separate operand. A scan that does not know about them either
// stops at the operand and reports no command — `bash -O extglob -c "git commit"` read
// `extglob` as a non-option and gave up — or, for `--rcfile`, matched the `c` inside the
// option name and returned the file path as though it were the payload. Either way the
// `-c` string was never unwrapped, so its `git commit` was never classified.
const shellLongOptionsWithOperand = new Set(["--rcfile", "--init-file"]);
const shellShortOptionsWithOperand = new Set(["o", "O"]);

const posixShellCommandArgument = (tokens: string[], index: number): string | undefined => {
  let cursor = index + 1;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    // `--` ends option parsing and `-` is an operand, so neither can be followed by a
    // command string this function is allowed to claim. An exhausted list claims nothing
    // either, which is what the loop bound already guarantees.
    if (token === undefined || token === "--" || token === "-") return undefined;
    if (!token.startsWith("-") && !token.startsWith("+")) return undefined;
    if (token.startsWith("--")) {
      if (token.includes("=")) {
        cursor += 1;
        continue;
      }
      cursor += shellLongOptionsWithOperand.has(token) ? 2 : 1;
      continue;
    }
    // A short cluster is read left to right. The first `c` makes the next unconsumed token
    // the command string; an `o` or `O` before it has already eaten one token of its own.
    let operandTokens = 0;
    for (const character of token.slice(1)) {
      if (character === "c") {
        return tokens[cursor + 1 + operandTokens];
      }
      if (shellShortOptionsWithOperand.has(character)) {
        operandTokens += 1;
      }
    }
    cursor += 1 + operandTokens;
  }
  return undefined;
};

const shellCommandArgument = (tokens: string[], index: number): string | undefined => {
  const executable = executableName(tokens[index] ?? "");
  if (executable === "cmd" || executable === "cmd.exe") {
    const commandIndex = tokens.findIndex((token, cursor) => cursor > index && token.toLowerCase() === "/c");
    return commandIndex >= 0 ? tokens[commandIndex + 1] : undefined;
  }
  if (executable === "powershell" || executable === "powershell.exe" || executable === "pwsh" || executable === "pwsh.exe") {
    const commandIndex = tokens.findIndex((token, cursor) => cursor > index && ["-command", "-c"].includes(token.toLowerCase()));
    return commandIndex >= 0 ? tokens[commandIndex + 1] : undefined;
  }
  if (executable === "eval") {
    return tokens[index + 1];
  }
  if (!["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(executable)) {
    return undefined;
  }
  return posixShellCommandArgument(tokens, index);
};

const unwrapShell = (command: string): string[] => {
  const tokens = shellTokens(command);
  const result: string[] = [];
  const aliases = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index] ?? "";
    const [, assignedName, assignedValue] = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/) ?? [];
    if (assignedName !== undefined && assignedValue !== undefined) {
      aliases.set(assignedName, assignedValue);
      continue;
    }
    const [, aliasName] = token.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/) ?? [];
    const aliased = aliasName === undefined ? undefined : aliases.get(aliasName);
    if (aliased !== undefined) {
      token = aliased;
    }
    const executable = executableName(token);
    if (executable === "env") {
      while (index + 1 < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index + 1] ?? "")) {
        index += 1;
      }
      continue;
    }
    if (["command", "builtin", "exec", "sudo"].includes(executable)) {
      continue;
    }
    const nestedCommand = shellCommandArgument(tokens, index);
    if (nestedCommand) {
      // Returning the nested expansion alone discarded every sibling segment, so a trailing
      // `; sh -c true` erased the command in front of it. Accumulate instead, and step over
      // the tokens the interpreter consumed so its own flags are not re-read as a command.
      result.push(...unwrapShell(nestedCommand));
      const consumed = tokens.indexOf(nestedCommand, index + 1);
      index = consumed >= 0 ? consumed : index;
      continue;
    }
    result.push(token);
  }
  return result;
};

const readOnlyGitSubcommands = new Set([
  "add",
  "apply",
  "blame",
  "cat-file",
  "diff",
  "grep",
  "log",
  "ls-files",
  "name-rev",
  "rev-parse",
  "shortlog",
  "show",
  "status",
]);

const containsGitMutation = (tokens: string[], allowedSubcommands: ReadonlySet<string> = readOnlyGitSubcommands): boolean => {
  for (let index = 0; index < tokens.length; index += 1) {
    if (executableName(tokens[index] ?? "") !== "git") continue;
    let cursor = index + 1;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      // The loop bound already proves a token is there; an exhausted list names no
      // subcommand, which is the same as finding no mutation on this `git`.
      if (token === undefined) break;
      if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "-c") {
        cursor += 2;
        continue;
      }
      if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("-c")) {
        cursor += 1;
        continue;
      }
      if (token.startsWith("-")) {
        cursor += 1;
        continue;
      }
      if (!allowedSubcommands.has(token.toLowerCase())) return true;
      index = cursor;
      break;
    }
  }
  return false;
};

const containsInterpreterWrappedGitMutation = (
  command: string,
  allowedSubcommands: ReadonlySet<string> = readOnlyGitSubcommands,
): boolean => {
  if (!/\b(?:python(?:\d+(?:\.\d+)*)?|node|perl|ruby|php)(?:\.exe)?\b/i.test(command)) return false;
  const flattened = command
    .replace(/[^A-Za-z0-9_./:=\-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return containsGitMutation(flattened, allowedSubcommands);
};

const observationalGitSubcommands = new Set(
  [...readOnlyGitSubcommands].filter((subcommand) => subcommand !== "add" && subcommand !== "apply"),
);

export const isCommitLikeCommand = (command: string): boolean =>
  containsGitMutation(unwrapShell(command)) || containsInterpreterWrappedGitMutation(command);

// Prevention, not detection. A tool request names its shell command in one of a few input
// fields; reading it before the tool runs lets a `commitMode: "never"` turn refuse the
// command outright. The post-run HEAD comparison stays as defence, but it can only report a
// commit that already happened.
const shellToolCommandFields = ["command", "cmd", "script"] as const;

export const toolRequestShellCommand = (
  toolInput: Record<string, unknown>,
): string | undefined => {
  for (const field of shellToolCommandFields) {
    const value = toolInput[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
};

export const commitPolicyRefusesToolRequest = (
  commitMode: "never" | "allow" | undefined,
  toolInput: Record<string, unknown>,
): boolean => {
  if (commitMode !== "never") return false;
  const command = toolRequestShellCommand(toolInput);
  return command !== undefined && isCommitLikeCommand(command);
};

export const isGitStateMutationCommand = (command: string): boolean =>
  containsGitMutation(unwrapShell(command), observationalGitSubcommands)
  || containsInterpreterWrappedGitMutation(command, observationalGitSubcommands);

const decodeGitQuotedPath = (value: string): string => {
  if (!(value.startsWith('"') && value.endsWith('"'))) {
    return value;
  }
  const bytes: number[] = [];
  const appendText = (text: string): void => {
    bytes.push(...Buffer.from(text, "utf8"));
  };
  const escapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
    "\\": 0x5c,
    '"': 0x22,
  };
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      appendText(char);
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) {
      throw new MutationPolicyError("Patch path contains an incomplete escape");
    }
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/u.test(body[index + 1 + octal.length] ?? "")) {
        octal += body[index + 1 + octal.length] ?? "";
      }
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const escapeCode = escapes[escaped];
    if (escapeCode !== undefined) {
      bytes.push(escapeCode);
      index += 1;
      continue;
    }
    appendText(escaped);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
};

const patchHeaderPath = (value: string, stripGitPrefix: boolean): string => {
  const withoutTimestamp = value.split("\t", 1)[0] ?? value;
  const decoded = decodeGitQuotedPath(withoutTimestamp);
  return stripGitPrefix && (decoded.startsWith("a/") || decoded.startsWith("b/"))
    ? decoded.slice(2)
    : decoded;
};

const patchPaths = (patch: string): string[] => {
  const values: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const fileHeader = /^(?:---|\+\+\+)\s+([\s\S]+)$/u.exec(line);
    const extendedHeader = /^(?:rename from|rename to|copy from|copy to)\s+([\s\S]+)$/u.exec(line);
    const raw = fileHeader?.[1] ?? extendedHeader?.[1];
    if (raw === undefined) {
      continue;
    }
    const parsed = patchHeaderPath(raw, fileHeader !== null);
    if (parsed !== "/dev/null") {
      values.push(parsed);
    }
  }
  return [...new Set(values)];
};

const collectMutationPaths = (action: unknown): string[] => {
  if (!action || typeof action !== "object") {
    return [];
  }
  const record = action as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["path", "targetPath", "sourcePath", "from", "to", "destination", "file"]) {
    if (typeof record[key] === "string") {
      paths.push(record[key] as string);
    }
  }
  if (Array.isArray(record.paths)) {
    paths.push(...record.paths.filter((entry): entry is string => typeof entry === "string"));
  }
  return [...new Set(paths)];
};

const actionKind = (action: unknown): string => {
  if (!action || typeof action !== "object") {
    return "";
  }
  const record = action as Record<string, unknown>;
  return String(record.kind ?? record.type ?? record.action ?? "").toLowerCase();
};

const commandValue = (action: unknown): string | undefined => {
  if (!action || typeof action !== "object") {
    return undefined;
  }
  const record = action as Record<string, unknown>;
  for (const key of ["command", "script", "shell"]) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  if (Array.isArray(record.args) && typeof record.args[0] === "string") {
    return record.args.join(" ");
  }
  return undefined;
};

export const assertWorkspaceActionAllowed = (
  action: unknown,
  context: MutationPolicyContext = {},
): void => {
  const kind = actionKind(action);
  if (kind === "shell.run" || /(?:^|[._-])shell(?:[._-]|$)|command|execute/.test(kind)) {
    throw new MutationPolicyError("Arbitrary shell actions are disabled; use structured workspace actions");
  }
  const mutation = /write|patch|delete|remove|rename|copy|move/.test(kind);
  if (mutation && context.readOnly) {
    throw new MutationPolicyError("This participant is read-only", "READ_ONLY");
  }
  for (const candidate of collectMutationPaths(action)) {
    const normalized = normalizeWorkspaceRelativePath(candidate);
    if (isRestrictedWorkspacePath(normalized, context.restrictedPaths)) {
      throw new MutationPolicyError(`Restricted path is not allowed: ${candidate}`, "RESTRICTED_PATH");
    }
    if (!isAllowedWorkspacePath(normalized, context.allowedPaths, context.scopeMode)) {
      throw new MutationPolicyError(`Path is outside the task scope: ${candidate}`, "PATH_OUTSIDE_SCOPE");
    }
  }
  const command = commandValue(action);
  if (command && (context.commitMode ?? "never") === "never" && isCommitLikeCommand(command)) {
    throw new MutationPolicyError("Git history-changing commands are disabled for this task", "GIT_MUTATION");
  }
};

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

export const assertExpectedFileHashes = async (
  workspaceRoot: string,
  expectedFiles: readonly { path: string; sha256: string }[],
  context: MutationPolicyContext = {},
): Promise<void> => {
  for (const expected of expectedFiles) {
    const resolvedPolicy = await assertWorkspacePathAllowed(workspaceRoot, expected.path, {
      ...context,
      workspaceRoot,
    });
    const absolute = path.resolve(workspaceRoot, resolvedPolicy.relative);
    let content: Buffer;
    try {
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new MutationPolicyError(`Expected source file must be a regular file: ${expected.path}`, "STALE_FILE");
      }
      const absoluteReal = await fs.realpath(absolute);
      if (absoluteReal !== resolvedPolicy.absolute) {
        throw new MutationPolicyError(`Expected source path changed while validating: ${expected.path}`, "STALE_FILE");
      }
      content = await fs.readFile(absoluteReal);
    } catch (error) {
      if (error instanceof MutationPolicyError) {
        throw error;
      }
      throw new MutationPolicyError(`Expected source file is unavailable: ${expected.path}`, "STALE_FILE");
    }
    if (sha256(content) !== expected.sha256.toLowerCase()) {
      throw new MutationPolicyError(`Source hash changed before mutation: ${expected.path}`, "STALE_FILE");
    }
  }
};

export const deriveMutationContext = (value: unknown): MutationPolicyContext => {
  const seen = new Set<unknown>();
  const result: MutationPolicyContext = {};
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || seen.has(entry)) {
      return;
    }
    seen.add(entry);
    const record = entry as Record<string, unknown>;
    if (!result.workspaceRoot && typeof record.workspaceRoot === "string") {
      result.workspaceRoot = record.workspaceRoot;
    }
    if (!result.workspaceRoot && typeof record.rootPath === "string") {
      result.workspaceRoot = record.rootPath;
    }
    if (!result.allowedPaths && Array.isArray(record.allowedPaths)) {
      result.allowedPaths = record.allowedPaths.filter((item): item is string => typeof item === "string");
    }
    if (!result.restrictedPaths && Array.isArray(record.restrictedPaths)) {
      result.restrictedPaths = record.restrictedPaths.filter((item): item is string => typeof item === "string");
    }
    if (record.commitMode === "allow" || record.commitMode === "never") {
      result.commitMode = record.commitMode;
    }
    if (record.readOnly === true) {
      result.readOnly = true;
    }
    if (record.scopeMode === "workspace" || record.scopeMode === "bounded") {
      result.scopeMode = record.scopeMode;
    }
    for (const nested of Object.values(record)) {
      visit(nested);
    }
  };
  visit(value);
  return result;
};

export const extractPatchPaths = patchPaths;
export const validateMutationPath = normalizeWorkspaceRelativePath;
export const isCommitCommand = isCommitLikeCommand;
