import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Readable } from "node:stream";

import {
  assertWorkspacePathAllowed,
  isRestrictedWorkspacePath,
  normalizeWorkspaceRelativePath,
} from "../browser/mutationPolicy";
import { setOptionalProperty } from "../state/optionalProperty";

export const tsJsExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
export const WHOLE_FILE_SNIPPET_MAX_BYTES = 24 * 1024;
export const textContextExtensions = new Set([
  ...tsJsExtensions,
  ".json", ".jsonc", ".md", ".mdx", ".yaml", ".yml", ".txt", ".toml", ".ini", ".conf",
  ".py", ".pyi", ".php", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".fs", ".fsx",
  ".c", ".h", ".cc", ".hh", ".cpp", ".hpp", ".cxx", ".hxx", ".m", ".mm",
  ".rb", ".swift", ".scala", ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".sql", ".graphql", ".gql", ".prisma", ".proto",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  ".xml", ".properties", ".env.example",
]);

const contextBasenames = new Set([
  "Dockerfile", "Containerfile", "Makefile", "GNUmakefile", "Procfile", "Justfile",
  "Gemfile", "Rakefile", "Vagrantfile", "CMakeLists.txt", "meson.build", "WORKSPACE", "BUILD", "BUILD.bazel",
]);

const contextExtensionPattern = Array.from(textContextExtensions)
  .filter((extension) => /^\.[a-z0-9]+$/i.test(extension))
  .map((extension) => extension.slice(1))
  .join(",");

export const isSupportedContextPath = (relativePath: string): boolean => {
  const platformPath = process.platform === "win32" ? relativePath.replace(/\\/g, "/") : relativePath;
  const base = path.posix.basename(platformPath);
  if (contextBasenames.has(base)) return true;
  if (base === ".env.example") return true;
  return textContextExtensions.has(path.posix.extname(base).toLowerCase());
};

export type SourceDeclaration = {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
};

export type SourceFileIndex = {
  path: string;
  sha256: string;
  version: number;
  declarations: SourceDeclaration[];
  imports: Array<{ specifier: string; names: string[] }>;
  exports: string[];
  reExports: string[];
  text: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type ContextSnippet = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
  hashScope?: "file" | "range";
  fileVersion: number;
  reason: string[];
  text: string;
  textTruncated?: boolean;
};

export type ContextInventoryTruncationReason = "fileLimit" | "timeout" | "ignoreFileLimit" | "ignoreByteLimit";

export type ContextIndexCoverage = {
  inventoryCount: number;
  maxInventoryFiles: number;
  inventoryTruncated: boolean;
  inventoryTimedOut: boolean;
  inventoryTruncationReason?: ContextInventoryTruncationReason;
  ignoreFileCount: number;
  indexedCount: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  indexedBytes: number;
  indexingTimedOut: boolean;
  truncated: boolean;
  skippedTooLarge: number;
  skippedUnreadable: number;
  skippedBudget: number;
  skippedFileLimit: number;
};

export type ContextIgnoreScope = {
  directory: string;
  rules: string[];
};

export type ContextIndex = {
  workspaceRoot: string;
  allowedPaths: string[];
  revision: number;
  files: Map<string, SourceFileIndex>;
  inventory: Set<string>;
  skippedTooLargePaths: Set<string>;
  skippedUnreadablePaths: Set<string>;
  skippedBudgetPaths: Set<string>;
  skippedFileLimitPaths: Set<string>;
  coverage: ContextIndexCoverage;
  compilerOptions: TsCompilerOptions;
  ignoreScopes: ContextIgnoreScope[];
  inventoryTimeoutMs: number;
  indexingTimeoutMs: number;
};

type TsMorphModule = typeof import("ts-morph");
type FastGlobModule = typeof import("fast-glob") & { default?: typeof import("fast-glob") };
type IgnoreModule = typeof import("ignore") & { default?: typeof import("ignore") };
type IgnoreMatcher = import("ignore").Ignore;
type IgnoreFactory = () => IgnoreMatcher;
type TsCompilerOptions = import("ts-morph").ts.CompilerOptions;
type TsProject = import("ts-morph").Project;
type FastGlobFn = typeof import("fast-glob");
type ParsedSourceFile = import("ts-morph").ts.SourceFile & { parseDiagnostics?: readonly import("ts-morph").ts.Diagnostic[] };

const loadLibraries = (): { tsMorph: TsMorphModule; fastGlob: FastGlobModule; ignore: IgnoreModule } => {
  const tsMorph: TsMorphModule = require("ts-morph");
  const fastGlob: FastGlobModule = require("fast-glob");
  const ignore: IgnoreModule = require("ignore");
  return { tsMorph, fastGlob, ignore };
};

const contextIndexCache = new Map<string, ContextIndex>();
type ContextSearchPlan = {
  residentRanked: Array<{ file: SourceFileIndex; score: number; reason: string[] }>;
  omittedPaths: string[];
  normalizedQuery: string;
  queryTokens: string[];
};
const contextSearchPlanCache = new WeakMap<ContextIndex, Map<string, ContextSearchPlan>>();
const maximumCachedContextSearchPlans = 3;
const maximumCachedContextIndexes = 2;
const yieldContextWork = async (): Promise<void> => await new Promise<void>((resolve) => setImmediate(resolve));

const cloneContextIndex = (index: ContextIndex): ContextIndex => ({
  ...index,
  allowedPaths: [...index.allowedPaths],
  files: new Map(index.files),
  inventory: new Set(index.inventory),
  skippedTooLargePaths: new Set(index.skippedTooLargePaths),
  skippedUnreadablePaths: new Set(index.skippedUnreadablePaths),
  skippedBudgetPaths: new Set(index.skippedBudgetPaths),
  skippedFileLimitPaths: new Set(index.skippedFileLimitPaths),
  coverage: { ...index.coverage },
  ignoreScopes: index.ignoreScopes.map((scope) => ({ directory: scope.directory, rules: [...scope.rules] })),
});

const cacheContextIndex = (key: string, index: ContextIndex): void => {
  contextIndexCache.delete(key);
  contextIndexCache.set(key, cloneContextIndex(index));
  while (contextIndexCache.size > maximumCachedContextIndexes) {
    const oldest = contextIndexCache.keys().next().value as string | undefined;
    if (!oldest) break;
    contextIndexCache.delete(oldest);
  }
};

const contextIndexCacheKey = (input: {
  workspaceRoot: string;
  allowedPaths?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxInventoryFiles?: number;
  inventoryTimeoutMs?: number;
  indexingTimeoutMs?: number;
}): string => JSON.stringify({
  workspaceRoot: path.resolve(input.workspaceRoot),
  allowedPaths: [...(input.allowedPaths ?? [])].sort(),
  maxFiles: input.maxFiles ?? 5000,
  maxFileBytes: input.maxFileBytes ?? 1_048_576,
  maxTotalBytes: input.maxTotalBytes ?? 128 * 1024 * 1024,
  maxInventoryFiles: input.maxInventoryFiles ?? 100_000,
  inventoryTimeoutMs: input.inventoryTimeoutMs ?? 30_000,
  indexingTimeoutMs: input.indexingTimeoutMs ?? 30_000,
});

const defaultCompilerOptions = (): TsCompilerOptions => {
  const { tsMorph } = loadLibraries();
  const ts = tsMorph.ts;
  return { allowJs: true, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext };
};

const parseCompilerOptions = (configPath: string): TsCompilerOptions | undefined => {
  const { tsMorph } = loadLibraries();
  const ts = tsMorph.ts;
  if (!ts.sys.fileExists(configPath)) return undefined;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return undefined;
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  return parsed.options ?? {};
};

const loadCompilerOptions = (workspaceRoot: string): TsCompilerOptions => {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const options = parseCompilerOptions(path.join(workspaceRoot, name));
    if (options) return options;
  }
  return defaultCompilerOptions();
};

const compilerOptionsByDirectory = new WeakMap<ContextIndex, Map<string, TsCompilerOptions>>();
const workspacePackagesByIndex = new WeakMap<ContextIndex, Map<string, { root: string; manifest: Record<string, unknown> }>>();

const compilerOptionsForFile = (index: ContextIndex, fromPath: string): TsCompilerOptions => {
  let cache = compilerOptionsByDirectory.get(index);
  if (!cache) {
    cache = new Map<string, TsCompilerOptions>();
    compilerOptionsByDirectory.set(index, cache);
  }
  const normalizedDirectory = path.posix.dirname(normalizePath(fromPath));
  const cached = cache.get(normalizedDirectory);
  if (cached) return cached;
  const workspaceRoot = path.resolve(index.workspaceRoot);
  let cursor = path.resolve(workspaceRoot, normalizedDirectory === "." ? "" : normalizedDirectory);
  const visited: string[] = [];
  while (true) {
    const relative = normalizePath(path.relative(workspaceRoot, cursor)) || ".";
    visited.push(relative);
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const options = parseCompilerOptions(path.join(cursor, name));
      if (!options) continue;
      for (const directory of visited) cache.set(directory, options);
      return options;
    }
    if (cursor === workspaceRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !insideWorkspacePath(workspaceRoot, parent)) break;
    cursor = parent;
  }
  for (const directory of visited) cache.set(directory, index.compilerOptions);
  return index.compilerOptions;
};

const insideWorkspacePath = (workspaceRoot: string, candidate: string): boolean => {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const workspacePackages = (index: ContextIndex): Map<string, { root: string; manifest: Record<string, unknown> }> => {
  const cached = workspacePackagesByIndex.get(index);
  if (cached) return cached;
  const packages = new Map<string, { root: string; manifest: Record<string, unknown> }>();
  for (const manifestPath of index.inventory) {
    if (path.posix.basename(manifestPath) !== "package.json") continue;
    const resident = index.files.get(manifestPath);
    if (!resident || resident.sizeBytes > 256 * 1024) continue;
    try {
      const manifest = JSON.parse(resident.text) as Record<string, unknown>;
      const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
      if (!name || packages.has(name)) continue;
      packages.set(name, { root: path.posix.dirname(manifestPath) === "." ? "" : path.posix.dirname(manifestPath), manifest });
    } catch {
      // EX-AUD-13. A manifest that will not parse contributes no package. The index still
      // describes every package that does parse, which is what a context graph needs.
    }
  }
  workspacePackagesByIndex.set(index, packages);
  return packages;
};

const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");
const normalizePath = (value: string): string => {
  const platformPath = process.platform === "win32" ? value.replace(/\\/g, "/") : value;
  return platformPath.replace(/^\.\//, "");
};

const builtInIgnoreRules = [
  ".git/", ".bachata/", "node_modules/", "dist/", "build/", "coverage/", ".next/", ".venv/", "venv/", "target/", "vendor/",
  ".cache/", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "bun.lockb",
];

const builtInGlobIgnores = [
  "**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.next/**",
  "**/.venv/**", "**/venv/**", "**/target/**", "**/vendor/**", "**/.cache/**",
  "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/npm-shrinkwrap.json", "**/bun.lockb",
];

type CompiledContextIgnoreScope = {
  directory: string;
  matcher: IgnoreMatcher;
};

const compileContextIgnoreScope = (
  scope: ContextIgnoreScope,
  ignoreFactory: IgnoreFactory,
): CompiledContextIgnoreScope => ({
  directory: scope.directory,
  matcher: ignoreFactory().add(scope.rules),
});

const contextPathIgnored = (
  relativePath: string,
  directory: boolean,
  scopes: readonly CompiledContextIgnoreScope[],
  builtInMatcher: IgnoreMatcher,
): boolean => {
  const normalized = normalizePath(relativePath).replace(/^\/+|\/+$/g, "");
  if (!normalized) return false;
  const rootCandidate = directory ? `${normalized}/` : normalized;
  if (builtInMatcher.test(rootCandidate).ignored) return true;
  let ignored = false;
  for (const scope of scopes) {
    if (scope.directory
      && normalized !== scope.directory
      && !normalized.startsWith(`${scope.directory}/`)) {
      continue;
    }
    const localPath = scope.directory
      ? normalized.slice(scope.directory.length).replace(/^\/+/, "")
      : normalized;
    if (!localPath) continue;
    const candidate = directory ? `${localPath.replace(/\/+$/, "")}/` : localPath;
    const result = scope.matcher.test(candidate) as { ignored: boolean; unignored: boolean };
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
};

const ignoreFilePatterns = (
  unrestricted: boolean,
  exactFiles: readonly string[],
  directoryRoots: readonly string[],
): string[] => {
  if (unrestricted) return [".gitignore", ".ignore", "**/.gitignore", "**/.ignore"];
  const patterns = new Set<string>([".gitignore", ".ignore"]);
  const appendAncestors = (value: string, valueIsDirectory: boolean): void => {
    const normalized = normalizePath(value).replace(/\/+$/, "");
    const directory = valueIsDirectory ? normalized : path.posix.dirname(normalized);
    if (!directory || directory === ".") return;
    const parts = directory.split("/").filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) {
      const prefix = parts.slice(0, index).join("/");
      patterns.add(`${prefix}/.gitignore`);
      patterns.add(`${prefix}/.ignore`);
    }
  };
  for (const exactFile of exactFiles) appendAncestors(exactFile, false);
  for (const directoryRoot of directoryRoots) {
    appendAncestors(directoryRoot, true);
    const root = normalizePath(directoryRoot).replace(/\/+$/, "");
    if (!root) continue;
    patterns.add(`${root}/**/.gitignore`);
    patterns.add(`${root}/**/.ignore`);
  }
  return [...patterns];
};

const readIgnoreScopes = async (
  workspaceRoot: string,
  glob: FastGlobFn,
  globOptions: Record<string, unknown>,
  patterns: readonly string[],
  ignoreFactory: IgnoreFactory,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<{
  scopes: ContextIgnoreScope[];
  truncated: boolean;
  timedOut: boolean;
  reason?: Exclude<ContextInventoryTruncationReason, "fileLimit">;
  fileCount: number;
}> => {
  const ignorePaths = new Set<string>();
  let timedOut = false;
  let truncated = false;
  if (Date.now() >= deadlineAt) {
    return { scopes: [], truncated: true, timedOut: true, reason: "timeout", fileCount: 0 };
  }
  const stream = glob.stream([...patterns], globOptions) as Readable;
  const timeout = setTimeout(() => {
    timedOut = true;
    truncated = true;
    stream.destroy();
  }, Math.max(1, deadlineAt - Date.now()));
  try {
    for await (const entry of stream) {
      if (signal?.aborted) {
        stream.destroy();
        throw new Error("Context indexing was cancelled");
      }
      if (ignorePaths.size >= 10_000) {
        truncated = true;
        stream.destroy();
        break;
      }
      let normalized: string;
      try {
        normalized = normalizeWorkspaceRelativePath(normalizePath(String(entry)));
      } catch {
        continue;
      }
      if (normalized === "." || isRestrictedWorkspacePath(normalized)) continue;
      ignorePaths.add(normalized);
    }
  } catch (error) {
    if (!timedOut && !truncated) throw error;
  } finally {
    clearTimeout(timeout);
    if (signal?.aborted || timedOut || truncated) stream.destroy();
  }
  if (truncated || Date.now() >= deadlineAt) {
    const expired = timedOut || Date.now() >= deadlineAt;
    return { scopes: [], truncated: true, timedOut: expired, reason: expired ? "timeout" : "ignoreFileLimit", fileCount: 0 };
  }
  const sortedPaths = [...ignorePaths].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    if (depth !== 0) return depth;
    const leftName = path.posix.basename(left);
    const rightName = path.posix.basename(right);
    if (leftName !== rightName) {
      if (leftName === ".gitignore") return -1;
      if (rightName === ".gitignore") return 1;
    }
    return left.localeCompare(right);
  });
  const scopes: ContextIgnoreScope[] = [];
  const compiledScopes: CompiledContextIgnoreScope[] = [];
  const builtInMatcher = ignoreFactory().add(builtInIgnoreRules);
  let totalBytes = 0;
  let fileCount = 0;
  for (const relativePath of sortedPaths) {
    if (signal?.aborted) throw new Error("Context indexing was cancelled");
    if (Date.now() >= deadlineAt) {
      return { scopes: [], truncated: true, timedOut: true, reason: "timeout", fileCount: 0 };
    }
    const parent = path.posix.dirname(relativePath);
    const directory = parent === "." ? "" : parent;
    if (directory && contextPathIgnored(directory, true, compiledScopes, builtInMatcher)) continue;
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    let info;
    try {
      info = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > 1_048_576 || totalBytes + info.size > 16 * 1024 * 1024) {
      return { scopes: [], truncated: true, timedOut: false, reason: "ignoreByteLimit", fileCount: 0 };
    }
    const readController = new AbortController();
    let readTimedOut = false;
    const abortRead = (): void => readController.abort();
    signal?.addEventListener("abort", abortRead, { once: true });
    const readTimeout = setTimeout(() => {
      readTimedOut = true;
      readController.abort();
    }, Math.max(1, deadlineAt - Date.now()));
    let content: string;
    try {
      content = await fs.readFile(absolutePath, { encoding: "utf8", signal: readController.signal });
    } catch (error) {
      if (signal?.aborted) throw new Error("Context indexing was cancelled");
      if (readTimedOut) return { scopes: [], truncated: true, timedOut: true, reason: "timeout", fileCount: 0 };
      throw error;
    } finally {
      clearTimeout(readTimeout);
      signal?.removeEventListener("abort", abortRead);
    }
    totalBytes += info.size;
    fileCount += 1;
    const scope = { directory, rules: content.split(/\r?\n/) };
    scopes.push(scope);
    compiledScopes.push(compileContextIgnoreScope(scope, ignoreFactory));
  }
  return { scopes, truncated: false, timedOut: false, fileCount };
};

const collectInventory = async (
  workspaceRoot: string,
  allowedPaths: string[],
  maxInventoryFiles: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{
  entries: string[];
  truncated: boolean;
  timedOut: boolean;
  truncationReason?: ContextInventoryTruncationReason;
  ignoreScopes: ContextIgnoreScope[];
  ignoreFileCount: number;
}> => {
  if (signal?.aborted) throw new Error("Context indexing was cancelled");
  const deadlineAt = Date.now() + Math.max(1, timeoutMs);
  const { fastGlob, ignore } = loadLibraries();
  const ignoreFactory: IgnoreFactory = ignore.default ?? ignore;
  const safeAllowedPaths = allowedPaths.map((prefix) => normalizeWorkspaceRelativePath(prefix));
  if (safeAllowedPaths.some((prefix) => prefix !== "." && isRestrictedWorkspacePath(prefix))) {
    throw new Error("Context allowedPaths contains a restricted workspace path");
  }
  const suffixes = [`**/*.{${contextExtensionPattern}}`, ...Array.from(contextBasenames, (name) => `**/${name}`), "**/.env.example"];
  const unrestricted = safeAllowedPaths.length === 0 || safeAllowedPaths.includes(".");
  const exactFiles: string[] = [];
  const directoryRoots: string[] = [];
  if (!unrestricted) {
    for (const allowedPath of safeAllowedPaths) {
      const absolute = path.resolve(workspaceRoot, allowedPath);
      try {
        const info = await fs.stat(absolute);
        if (info.isDirectory()) {
          directoryRoots.push(`${normalizePath(allowedPath).replace(/\/$/, "")}/`);
        } else if (info.isFile()) {
          exactFiles.push(normalizePath(allowedPath));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (/[\\/]$/u.test(allowedPath)) {
          directoryRoots.push(`${normalizePath(allowedPath).replace(/\/$/, "")}/`);
        } else {
          exactFiles.push(normalizePath(allowedPath));
        }
      }
    }
  }
  const roots = unrestricted ? [""] : directoryRoots;
  const patterns = [...exactFiles, ...roots.flatMap((root) => suffixes.map((suffix) => `${root}${suffix}`))];
  const glob: FastGlobFn = fastGlob.default ?? fastGlob;
  const globOptions = {
    cwd: workspaceRoot,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    dot: true,
    ignore: builtInGlobIgnores,
  };
  const ignoreResult = await readIgnoreScopes(
    workspaceRoot,
    glob,
    globOptions,
    ignoreFilePatterns(unrestricted, exactFiles, directoryRoots),
    ignoreFactory,
    deadlineAt,
    signal,
  );
  if (ignoreResult.truncated) {
    return {
      entries: [],
      truncated: true,
      timedOut: ignoreResult.timedOut,
      ...(ignoreResult.reason ? { truncationReason: ignoreResult.reason } : {}),
      ignoreScopes: [],
      ignoreFileCount: 0,
    };
  }
  const compiledScopes = ignoreResult.scopes.map((scope) => compileContextIgnoreScope(scope, ignoreFactory));
  const builtInMatcher = ignoreFactory().add(builtInIgnoreRules);
  const entries = new Set<string>();
  let truncated = false;
  let timedOut = false;
  let truncationReason: ContextInventoryTruncationReason | undefined;
  if (Date.now() >= deadlineAt) {
    return {
      entries: [],
      truncated: true,
      timedOut: true,
      truncationReason: "timeout",
      ignoreScopes: ignoreResult.scopes,
      ignoreFileCount: ignoreResult.fileCount,
    };
  }
  if (patterns.length === 0) {
    return {
      entries: [],
      truncated: false,
      timedOut: false,
      ignoreScopes: ignoreResult.scopes,
      ignoreFileCount: ignoreResult.fileCount,
    };
  }
  const stream = glob.stream(patterns, globOptions) as Readable;
  const timeout = setTimeout(() => {
    timedOut = true;
    truncated = true;
    truncationReason = "timeout";
    stream.destroy();
  }, Math.max(1, deadlineAt - Date.now()));
  try {
    for await (const entry of stream) {
      if (signal?.aborted) {
        stream.destroy();
        throw new Error("Context indexing was cancelled");
      }
      let normalized: string;
      try {
        normalized = normalizeWorkspaceRelativePath(normalizePath(String(entry)));
      } catch {
        continue;
      }
      if (normalized === "."
        || !isSupportedContextPath(normalized)
        || contextPathIgnored(normalized, false, compiledScopes, builtInMatcher)
        || isRestrictedWorkspacePath(normalized)) {
        continue;
      }
      if (entries.size >= maxInventoryFiles) {
        truncated = true;
        truncationReason = "fileLimit";
        stream.destroy();
        break;
      }
      entries.add(normalized);
    }
  } catch (error) {
    if (!timedOut && !truncated) throw error;
  } finally {
    clearTimeout(timeout);
    if (signal?.aborted || timedOut || truncated) stream.destroy();
  }
  return {
    entries: [...entries].sort((left, right) => left.localeCompare(right)),
    truncated,
    timedOut,
    ...(truncationReason ? { truncationReason } : {}),
    ignoreScopes: ignoreResult.scopes,
    ignoreFileCount: ignoreResult.fileCount,
  };
};

const resolveContextSource = async (
  workspaceRoot: string,
  relativePath: string,
  allowedPaths: readonly string[],
): Promise<{ absolutePath: string; size: number; mtimeMs: number }> => {
  const policyPath = await assertWorkspacePathAllowed(workspaceRoot, relativePath, { allowedPaths: [...allowedPaths] });
  if (policyPath.relative === ".") {
    throw new Error(`Restricted context path: ${relativePath}`);
  }
  const lexical = path.resolve(workspaceRoot, policyPath.relative);
  const info = await fs.lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Context source is not a regular file: ${relativePath}`);
  }
  const resolved = await fs.realpath(lexical);
  if (resolved !== policyPath.absolute) {
    throw new Error(`Context source changed while resolving: ${relativePath}`);
  }
  return { absolutePath: resolved, size: info.size, mtimeMs: info.mtimeMs };
};

const plainFileIndex = (
  relativePath: string,
  text: string,
  version: number,
  sizeBytes: number,
  mtimeMs: number,
): SourceFileIndex => ({
  path: relativePath,
  sha256: hashText(text),
  version,
  declarations: [],
  imports: [],
  exports: [],
  reExports: [],
  text,
  sizeBytes,
  mtimeMs,
});

const contextIndexDeadlineMessage = "Context indexing deadline expired";

const assertContextIndexingActive = (signal?: AbortSignal, deadlineAt?: number): void => {
  if (signal?.aborted) throw new Error("Context indexing was cancelled");
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Error(contextIndexDeadlineMessage);
};

const readContextText = async (
  absolutePath: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<string> => {
  assertContextIndexingActive(signal, deadlineAt);
  const controller = new AbortController();
  let deadlineExpired = false;
  const abortRead = (): void => controller.abort();
  signal?.addEventListener("abort", abortRead, { once: true });
  const timer = deadlineAt === undefined
    ? undefined
    : setTimeout(() => {
        deadlineExpired = true;
        controller.abort();
      }, Math.max(1, deadlineAt - Date.now()));
  try {
    return await fs.readFile(absolutePath, { encoding: "utf8", signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw new Error("Context indexing was cancelled");
    if (deadlineExpired) throw new Error(contextIndexDeadlineMessage);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abortRead);
  }
};

const indexFile = async (
  project: TsProject,
  workspaceRoot: string,
  relativePath: string,
  version: number,
  allowedPaths: readonly string[],
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<SourceFileIndex> => {
  assertContextIndexingActive(signal, deadlineAt);
  const sourceInfo = await resolveContextSource(workspaceRoot, relativePath, allowedPaths);
  assertContextIndexingActive(signal, deadlineAt);
  const text = await readContextText(sourceInfo.absolutePath, signal, deadlineAt);
  assertContextIndexingActive(signal, deadlineAt);
  if (!tsJsExtensions.has(path.extname(relativePath).toLowerCase())) {
    return plainFileIndex(relativePath, text, version, sourceInfo.size, sourceInfo.mtimeMs);
  }
  const { tsMorph } = loadLibraries();
  const source = project.createSourceFile(relativePath, text, { overwrite: true });
  assertContextIndexingActive(signal, deadlineAt);
  const declarations: SourceDeclaration[] = [];
  for (const statement of source.getStatements()) {
    const named = statement as unknown as { getName?: () => string | undefined; isExported?: () => boolean };
    const name = named.getName?.();
    if (!name) continue;
    declarations.push({
      name,
      kind: statement.getKindName(),
      startLine: statement.getStartLineNumber(),
      endLine: statement.getEndLineNumber(),
      exported: named.isExported?.() ?? false,
    });
  }
  const imports = source.getImportDeclarations().map((declaration) => ({
    specifier: declaration.getModuleSpecifierValue(),
    names: [
      declaration.getDefaultImport()?.getText(),
      ...declaration.getNamedImports().map((named) => named.getName()),
      declaration.getNamespaceImport()?.getText(),
    ].filter((value): value is string => !!value),
  }));
  for (const call of source.getDescendantsOfKind(tsMorph.SyntaxKind.CallExpression)) {
    const expression = call.getExpression().getText();
    if (expression !== "require" && expression !== "import") continue;
    const argument = call.getArguments()[0];
    if (!argument || (argument.getKindName() !== "StringLiteral" && argument.getKindName() !== "NoSubstitutionTemplateLiteral")) continue;
    const specifier = argument.getText().slice(1, -1);
    if (specifier && !imports.some((entry: { specifier: string }) => entry.specifier === specifier)) imports.push({ specifier, names: [] });
  }
  const exportedNames = declarations.filter((declaration: { exported: boolean }) => declaration.exported).map((declaration: { name: string }) => declaration.name).sort();
  const reExports = source
    .getExportDeclarations()
    .map((declaration) => declaration.getModuleSpecifierValue())
    .filter((value: string | undefined): value is string => !!value);
  assertContextIndexingActive(signal, deadlineAt);
  return {
    path: relativePath,
    sha256: hashText(text),
    version,
    declarations,
    imports,
    exports: exportedNames,
    reExports,
    text,
    sizeBytes: sourceInfo.size,
    mtimeMs: sourceInfo.mtimeMs,
  };
};

export const buildTsJsContextIndex = async (input: {
  workspaceRoot: string;
  allowedPaths?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxInventoryFiles?: number;
  inventoryTimeoutMs?: number;
  indexingTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ContextIndex> => {
  const maxFiles = Math.max(1, input.maxFiles ?? 5000);
  const maxFileBytes = Math.max(1, input.maxFileBytes ?? 1_048_576);
  const maxTotalBytes = Math.max(maxFileBytes, input.maxTotalBytes ?? 128 * 1024 * 1024);
  const maxInventoryFiles = Math.max(maxFiles, input.maxInventoryFiles ?? 100_000);
  const inventoryTimeoutMs = Math.max(1_000, input.inventoryTimeoutMs ?? 30_000);
  const indexingTimeoutMs = Math.max(1_000, input.indexingTimeoutMs ?? 30_000);
  const inventoryResult = await collectInventory(input.workspaceRoot, input.allowedPaths ?? [], maxInventoryFiles, inventoryTimeoutMs, input.signal);
  const inventory = inventoryResult.entries;
  const indexingDeadlineAt = Date.now() + indexingTimeoutMs;
  const files = new Map<string, SourceFileIndex>();
  const cacheKey = contextIndexCacheKey(input);
  const cachedSnapshot = contextIndexCache.get(cacheKey);
  const inventoryMatchesCache = Boolean(
    cachedSnapshot
    && !inventoryResult.truncated
    && !cachedSnapshot.coverage.inventoryTruncated
    && !cachedSnapshot.coverage.inventoryTimedOut
    && !cachedSnapshot.coverage.indexingTimedOut
    && cachedSnapshot.inventory.size === inventory.length
    && inventory.every((relativePath) => cachedSnapshot.inventory.has(relativePath)),
  );
  if (cachedSnapshot && !inventoryMatchesCache) {
    contextIndexCache.delete(cacheKey);
  }
  if (cachedSnapshot && inventoryMatchesCache) {
    contextIndexCache.delete(cacheKey);
    const cached = cloneContextIndex(cachedSnapshot);
    const nextInventory = new Set(inventory);
    const stale: string[] = [];
    const freshnessChecked = new Set<string>();
    let indexingTimedOut = false;
    let freshnessIndex = 0;
    for (const [relativePath, file] of cached.files) {
      if (input.signal?.aborted) throw new Error("Context indexing was cancelled");
      if (Date.now() >= indexingDeadlineAt) {
        indexingTimedOut = true;
        break;
      }
      if (freshnessIndex > 0 && freshnessIndex % 64 === 0) await yieldContextWork();
      freshnessIndex += 1;
      freshnessChecked.add(relativePath);
      if (!nextInventory.has(relativePath)) {
        cached.files.delete(relativePath);
        continue;
      }
      try {
        const source = await resolveContextSource(input.workspaceRoot, relativePath, input.allowedPaths ?? []);
        if (source.size !== file.sizeBytes || source.mtimeMs !== file.mtimeMs) stale.push(relativePath);
      } catch {
        stale.push(relativePath);
      }
    }
    if (indexingTimedOut) {
      for (const relativePath of [...cached.files.keys()]) {
        if (!freshnessChecked.has(relativePath)) {
          cached.files.delete(relativePath);
          cached.skippedBudgetPaths.add(relativePath);
        }
      }
    }
    cached.inventory = nextInventory;
    cached.ignoreScopes = inventoryResult.ignoreScopes.map((scope) => ({ directory: scope.directory, rules: [...scope.rules] }));
    cached.inventoryTimeoutMs = inventoryTimeoutMs;
    cached.indexingTimeoutMs = indexingTimeoutMs;
    cached.compilerOptions = loadCompilerOptions(input.workspaceRoot);
    for (const set of [
      cached.skippedTooLargePaths,
      cached.skippedUnreadablePaths,
      cached.skippedBudgetPaths,
      cached.skippedFileLimitPaths,
    ]) {
      for (const relativePath of [...set]) if (!nextInventory.has(relativePath)) set.delete(relativePath);
    }
    if (stale.length > 0 && Date.now() < indexingDeadlineAt) {
      const refreshResult = await refreshContextFiles(cached, stale, input.signal, indexingDeadlineAt);
      indexingTimedOut = indexingTimedOut || refreshResult.timedOut;
    } else {
      if (stale.length > 0) indexingTimedOut = true;
      stale.forEach((relativePath) => {
        cached.files.delete(relativePath);
        cached.skippedBudgetPaths.add(relativePath);
      });
    }
    const cachedBytes = (): number => Array.from(cached.files.values())
      .reduce((total, file) => total + Buffer.byteLength(file.text, "utf8"), 0);
    if (!indexingTimedOut
      && Date.now() < indexingDeadlineAt
      && cached.files.size < maxFiles
      && cachedBytes() < maxTotalBytes) {
      const backfillCandidates = [...new Set([
        ...cached.skippedFileLimitPaths,
        ...cached.skippedBudgetPaths,
        ...cached.skippedTooLargePaths,
        ...cached.skippedUnreadablePaths,
      ])]
        .filter((relativePath) => nextInventory.has(relativePath) && !cached.files.has(relativePath))
        .sort((left, right) => left.localeCompare(right));
      if (backfillCandidates.length > 0) {
        const refreshResult = await refreshContextFiles(
          cached,
          backfillCandidates,
          input.signal,
          indexingDeadlineAt,
          { fillOnly: true },
        );
        indexingTimedOut = indexingTimedOut || refreshResult.timedOut;
      }
    }
    let coverageIndex = 0;
    for (const relativePath of nextInventory) {
      if (input.signal?.aborted) throw new Error("Context indexing was cancelled");
      if (coverageIndex > 0 && coverageIndex % 512 === 0) await yieldContextWork();
      coverageIndex += 1;
      if (!cached.files.has(relativePath)
        && !cached.skippedTooLargePaths.has(relativePath)
        && !cached.skippedUnreadablePaths.has(relativePath)
        && !cached.skippedBudgetPaths.has(relativePath)) {
        cached.skippedFileLimitPaths.add(relativePath);
      }
    }
    cached.coverage.inventoryCount = nextInventory.size;
    cached.coverage.maxInventoryFiles = maxInventoryFiles;
    cached.coverage.inventoryTruncated = inventoryResult.truncated;
    cached.coverage.inventoryTimedOut = inventoryResult.timedOut;
    setOptionalProperty(cached.coverage, "inventoryTruncationReason", inventoryResult.truncationReason);
    cached.coverage.ignoreFileCount = inventoryResult.ignoreFileCount;
    cached.coverage.indexedCount = cached.files.size;
    cached.coverage.indexedBytes = Array.from(cached.files.values())
      .reduce((total, file) => total + Buffer.byteLength(file.text, "utf8"), 0);
    cached.coverage.skippedTooLarge = cached.skippedTooLargePaths.size;
    cached.coverage.skippedUnreadable = cached.skippedUnreadablePaths.size;
    cached.coverage.skippedBudget = cached.skippedBudgetPaths.size;
    cached.coverage.skippedFileLimit = cached.skippedFileLimitPaths.size;
    cached.coverage.indexingTimedOut = indexingTimedOut;
    cached.coverage.truncated = inventoryResult.truncated
      || indexingTimedOut
      || cached.files.size < nextInventory.size
      || cached.skippedTooLargePaths.size > 0
      || cached.skippedUnreadablePaths.size > 0
      || cached.skippedBudgetPaths.size > 0
      || cached.skippedFileLimitPaths.size > 0;
    if (!cached.coverage.inventoryTruncated
      && !cached.coverage.inventoryTimedOut
      && !cached.coverage.indexingTimedOut) {
      cacheContextIndex(cacheKey, cached);
    }
    return cached;
  }
  let indexedBytes = 0;
  const skippedTooLargePaths = new Set<string>();
  const skippedUnreadablePaths = new Set<string>();
  const skippedBudgetPaths = new Set<string>();
  const skippedFileLimitPaths = new Set<string>();
  const { tsMorph } = loadLibraries();
  const compilerOptions = loadCompilerOptions(input.workspaceRoot);
  const project = new tsMorph.Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions });
  const selectedInventory = (() => {
    if (inventory.length <= maxFiles) return inventory;
    const primaryPositions = maxFiles === 1
      ? [Math.floor((inventory.length - 1) / 2)]
      : Array.from({ length: maxFiles }, (_, index) =>
          Math.round(index * (inventory.length - 1) / (maxFiles - 1)));
    const selectedPositions = new Set(primaryPositions);
    const maximumCandidates = Math.min(
      inventory.length,
      Math.max(maxFiles, Math.min(maxInventoryFiles, maxFiles * 4)),
    );
    return [
      // Every position came from this inventory, so the flatMap drops nothing; it is what
      // lets the selection stay a list of paths rather than a list of maybe-paths.
      ...primaryPositions.flatMap((position) => inventory[position] ?? []),
      ...inventory.filter((_entry, position) => !selectedPositions.has(position)),
    ].slice(0, maximumCandidates);
  })();
  let indexingTimedOut = false;
  let selectedIndex = 0;
  for (const relativePath of selectedInventory) {
    if (input.signal?.aborted) throw new Error("Context indexing was cancelled");
    if (selectedIndex > 0 && selectedIndex % 32 === 0) await yieldContextWork();
    selectedIndex += 1;
    if (Date.now() >= indexingDeadlineAt) {
      indexingTimedOut = true;
      break;
    }
    if (files.size >= maxFiles) break;
    try {
      const source = await resolveContextSource(input.workspaceRoot, relativePath, input.allowedPaths ?? []);
      if (source.size > maxFileBytes) {
        skippedTooLargePaths.add(relativePath);
        continue;
      }
      if (indexedBytes + source.size > maxTotalBytes) {
        skippedBudgetPaths.add(relativePath);
        continue;
      }
      const file = await indexFile(
        project,
        input.workspaceRoot,
        relativePath,
        1,
        input.allowedPaths ?? [],
        input.signal,
        indexingDeadlineAt,
      );
      const fileBytes = Buffer.byteLength(file.text, "utf8");
      if (fileBytes > maxFileBytes) {
        skippedTooLargePaths.add(relativePath);
        continue;
      }
      if (indexedBytes + fileBytes > maxTotalBytes) {
        skippedBudgetPaths.add(relativePath);
        continue;
      }
      files.set(relativePath, file);
      indexedBytes += fileBytes;
    } catch (error) {
      if (input.signal?.aborted) throw new Error("Context indexing was cancelled");
      if (error instanceof Error && error.message === contextIndexDeadlineMessage) {
        indexingTimedOut = true;
        for (const remainingPath of selectedInventory.slice(Math.max(0, selectedIndex - 1))) {
          skippedBudgetPaths.add(remainingPath);
        }
        break;
      }
      skippedUnreadablePaths.add(relativePath);
    }
  }
  let finalCoverageIndex = 0;
  for (const relativePath of inventory) {
    if (input.signal?.aborted) throw new Error("Context indexing was cancelled");
    if (finalCoverageIndex > 0 && finalCoverageIndex % 512 === 0) await yieldContextWork();
    finalCoverageIndex += 1;
    if (!files.has(relativePath)
      && !skippedTooLargePaths.has(relativePath)
      && !skippedUnreadablePaths.has(relativePath)
      && !skippedBudgetPaths.has(relativePath)) {
      skippedFileLimitPaths.add(relativePath);
    }
  }
  const index: ContextIndex = {
    workspaceRoot: input.workspaceRoot,
    allowedPaths: [...(input.allowedPaths ?? [])],
    revision: 1,
    files,
    inventory: new Set(inventory),
    skippedTooLargePaths,
    skippedUnreadablePaths,
    skippedBudgetPaths,
    skippedFileLimitPaths,
    coverage: {
      inventoryCount: inventory.length,
      maxInventoryFiles,
      inventoryTruncated: inventoryResult.truncated,
      inventoryTimedOut: inventoryResult.timedOut,
      ...(inventoryResult.truncationReason ? { inventoryTruncationReason: inventoryResult.truncationReason } : {}),
      ignoreFileCount: inventoryResult.ignoreFileCount,
      indexedCount: files.size,
      maxFiles,
      maxFileBytes,
      maxTotalBytes,
      indexedBytes,
      indexingTimedOut,
      truncated: inventoryResult.truncated || indexingTimedOut || files.size < inventory.length || skippedTooLargePaths.size > 0 || skippedUnreadablePaths.size > 0 || skippedBudgetPaths.size > 0 || skippedFileLimitPaths.size > 0,
      skippedTooLarge: skippedTooLargePaths.size,
      skippedUnreadable: skippedUnreadablePaths.size,
      skippedBudget: skippedBudgetPaths.size,
      skippedFileLimit: skippedFileLimitPaths.size,
    },
    compilerOptions,
    ignoreScopes: inventoryResult.ignoreScopes.map((scope) => ({ directory: scope.directory, rules: [...scope.rules] })),
    inventoryTimeoutMs,
    indexingTimeoutMs,
  };
  if (!index.coverage.inventoryTruncated
    && !index.coverage.inventoryTimedOut
    && !index.coverage.indexingTimedOut) {
    cacheContextIndex(cacheKey, index);
  }
  return index;
};

const maximumContextSearchPhraseLength = 4_096;
const maximumContextSearchTokenCount = 64;
const maximumContextSearchTokenLength = 128;

const normalizedSearchPhrase = (value: string): string =>
  value.trim().toLowerCase().slice(0, maximumContextSearchPhraseLength);

const tokenize = (value: string): string[] => Array.from(new Set(
  value.toLowerCase().match(/[\p{L}_$][\p{L}\p{M}\p{N}_$-]{1,}/gu) ?? [],
))
  .filter((token) => token.length <= maximumContextSearchTokenLength)
  .slice(0, maximumContextSearchTokenCount);

export const taskRelevantInventoryPaths = (
  index: ContextIndex,
  task: string,
  maxPaths = 256,
): string[] => {
  const stopWords = new Set(["fix", "code", "bug", "issue", "review", "implementation", "feature", "work", "task", "file", "files", "project"]);
  const tokens = tokenize(task).filter((token) => token.length >= 3 && !stopWords.has(token));
  if (tokens.length === 0) return [];
  return [...index.inventory]
    .map((relativePath) => {
      const lower = relativePath.toLowerCase();
      const basename = path.posix.basename(lower);
      const segments = lower.split("/");
      let score = 0;
      for (const token of tokens) {
        if (basename.includes(token)) score += 8;
        else if (segments.some((segment) => segment.includes(token))) score += 4;
        else if (lower.includes(token)) score += 1;
      }
      return { relativePath, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
    .slice(0, Math.max(0, maxPaths))
    .map((entry) => entry.relativePath);
};

const scoreFile = (file: SourceFileIndex, input: {
  task: string;
  taskTokens?: readonly string[];
  changedFiles: Set<string>;
  seedFiles: Set<string>;
  errorText: string;
}): { score: number; reason: string[] } => {
  let score = 0;
  const reason: string[] = [];
  const taskTokens = input.taskTokens ?? tokenize(input.task);
  const searchable = `${file.path}\n${file.declarations.map((declaration) => declaration.name).join(" ")}\n${file.exports.join(" ")}\n${file.text}`.toLowerCase();
  if (input.seedFiles.has(file.path)) { score += 140; reason.push("explicit-task-path"); }
  if (input.changedFiles.has(file.path)) { score += 80; reason.push("changed-file"); }
  if (input.errorText.includes(file.path)) { score += 100; reason.push("error-path"); }
  for (const token of taskTokens) {
    if (file.path.toLowerCase().includes(token)) { score += 18; reason.push(`path:${token}`); }
    if (file.declarations.some((declaration) => declaration.name.toLowerCase() === token)) { score += 40; reason.push(`symbol:${token}`); }
    if (searchable.includes(token)) score += 2;
  }
  return { score, reason };
};

const resolveIndexedImport = (index: ContextIndex, fromPath: string, specifier: string): string | undefined => {
  const { tsMorph } = loadLibraries();
  const ts = tsMorph.ts;
  const containingFile = path.join(index.workspaceRoot, fromPath);
  const compilerOptions = compilerOptionsForFile(index, fromPath);
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
  if (typeof resolved === "string") {
    const resolvedCandidates = [
      resolved,
      typeof ts.sys.realpath === "function" ? ts.sys.realpath(resolved) : resolved,
    ];
    for (const candidate of new Set(resolvedCandidates)) {
      const relative = normalizePath(path.relative(index.workspaceRoot, candidate));
      if (!relative.startsWith("../") && index.inventory.has(relative)) return relative;
    }
  }
  if (!specifier.startsWith(".")) {
    const packages = workspacePackages(index);
    const packageName = [...packages.keys()]
      .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (!packageName) return undefined;
    const entry = packages.get(packageName)!;
    const subpath = specifier === packageName ? "" : specifier.slice(packageName.length + 1);
    const manifestEntries = [entry.manifest.source, entry.manifest.types, entry.manifest.module, entry.manifest.main]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const packageBases = subpath
      ? [path.posix.join(entry.root, subpath), path.posix.join(entry.root, "src", subpath)]
      : [
          ...manifestEntries.map((value) => path.posix.join(entry.root, value)),
          path.posix.join(entry.root, "src/index"),
          path.posix.join(entry.root, "index"),
        ];
    const packageCandidates = packageBases.flatMap((base) => [
      normalizePath(base),
      ...Array.from(tsJsExtensions, (extension) => `${normalizePath(base)}${extension}`),
      ...Array.from(tsJsExtensions, (extension) => `${normalizePath(base)}/index${extension}`),
    ]);
    return packageCandidates.find((candidate) => index.inventory.has(candidate));
  }
  const base = normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier)));
  const candidates = [
    base,
    ...Array.from(tsJsExtensions, (extension) => `${base}${extension}`),
    ...Array.from(tsJsExtensions, (extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => index.inventory.has(candidate));
};

export type ContextDependencyEdge = {
  path: string;
  specifiers: string[];
};

export type ContextDependentsPage = {
  results: ContextDependencyEdge[];
  nextCursor?: string;
  scan: { pathsExamined: number; filesScanned: number; bytesScanned: number; elapsedMs: number; exhausted: boolean; stoppedBy?: "fileLimit" | "byteLimit" | "timeout" | "resultLimit" };
};

const dependencySpecifiers = (file: SourceFileIndex): string[] => [
  ...file.imports.map((entry) => entry.specifier),
  ...file.reExports,
];

export const promoteContextDependencies = async (
  index: ContextIndex,
  roots: readonly string[],
  signal?: AbortSignal,
  maxDepth = 2,
  maxPromotionBytes = 768 * 1024,
): Promise<string[]> => {
  const normalizedRoots = [...new Set(roots.map(normalizePath).map(normalizeWorkspaceRelativePath))]
    .filter((relativePath) => index.inventory.has(relativePath));
  if (normalizedRoots.length > 0) await refreshContextFiles(index, normalizedRoots, signal);
  const queue = normalizedRoots.map((relativePath) => ({ relativePath, depth: 0 }));
  const visited = new Set(normalizedRoots);
  const promoted = new Set<string>();
  let promotionBytes = 0;
  let budgetExhausted = false;
  while (queue.length > 0 && !budgetExhausted) {
    if (signal?.aborted) throw new Error("Context dependency promotion was cancelled");
    const current = queue.shift()!;
    if (current.depth >= Math.max(0, maxDepth)) continue;
    const file = index.files.get(current.relativePath);
    if (!file) continue;
    const resolved = [...new Set(dependencySpecifiers(file)
      .map((specifier) => resolveIndexedImport(index, file.path, specifier))
      .filter((value): value is string => Boolean(value)))];
    const missing = resolved.filter((relativePath) => !index.files.has(relativePath));
    if (missing.length > 0) {
      await refreshContextFiles(index, missing, signal);
      for (const relativePath of missing) {
        const added = index.files.get(relativePath);
        if (added) promotionBytes += Buffer.byteLength(added.text, "utf8");
      }
      if (promotionBytes > Math.max(1, maxPromotionBytes)) budgetExhausted = true;
    }
    for (const relativePath of resolved) {
      promoted.add(relativePath);
      if (!visited.has(relativePath) && index.files.has(relativePath)) {
        visited.add(relativePath);
        queue.push({ relativePath, depth: current.depth + 1 });
      }
    }
  }
  return [...promoted].sort((left, right) => left.localeCompare(right));
};

export const contextDependencies = async (
  index: ContextIndex,
  relativePath: string,
  signal?: AbortSignal,
): Promise<ContextDependencyEdge[]> => {
  const normalized = normalizeWorkspaceRelativePath(normalizePath(relativePath));
  if (!index.inventory.has(normalized)) throw new Error(`Context dependency target is not in the readable inventory: ${relativePath}`);
  if (!index.files.has(normalized)) await refreshContextFiles(index, [normalized], signal);
  const file = index.files.get(normalized);
  if (!file) throw new Error(`Context dependency target could not be indexed: ${relativePath}`);
  const grouped = new Map<string, Set<string>>();
  for (const specifier of dependencySpecifiers(file)) {
    const resolved = resolveIndexedImport(index, file.path, specifier);
    if (!resolved) continue;
    const values = grouped.get(resolved) ?? new Set<string>();
    values.add(specifier);
    grouped.set(resolved, values);
  }
  const missing = [...grouped.keys()].filter((candidate) => !index.files.has(candidate));
  if (missing.length > 0) await refreshContextFiles(index, missing, signal);
  return [...grouped.entries()]
    .map(([candidate, specifiers]) => ({ path: candidate, specifiers: [...specifiers].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
};

const dependentsCursorHash = (index: ContextIndex, target: string): string =>
  hashText(`${String(index.revision)}\0${target}`).slice(0, 12);

export const contextDependentsPage = async (
  index: ContextIndex,
  relativePath: string,
  options: { cursor?: string; maxScanFiles: number; maxScanBytes: number; maxFileScanBytes: number; timeoutMs: number; maxResults?: number; signal?: AbortSignal },
): Promise<ContextDependentsPage> => {
  const target = normalizeWorkspaceRelativePath(normalizePath(relativePath));
  if (!index.inventory.has(target)) throw new Error(`Context dependent target is not in the readable inventory: ${relativePath}`);
  const inventory = [...index.inventory].filter((candidate) => tsJsExtensions.has(path.posix.extname(candidate).toLowerCase())).sort((left, right) => left.localeCompare(right));
  const cursorHash = dependentsCursorHash(index, target);
  let offset = 0;
  if (options.cursor) {
    const match = /^v1:([a-f0-9]{12}):(\d+)$/u.exec(options.cursor);
    if (!match || match[1] !== cursorHash) throw new Error("Context dependents cursor is stale or invalid");
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > inventory.length) throw new Error("Context dependents cursor offset is invalid");
  }
  const started = Date.now();
  const deadline = started + Math.max(1_000, options.timeoutMs);
  const maxResults = Math.max(1, Math.min(256, options.maxResults ?? 128));
  const { tsMorph } = loadLibraries();
  const ts = tsMorph.ts;
  const results: ContextDependencyEdge[] = [];
  let pathsExamined = 0;
  let filesScanned = 0;
  let bytesScanned = 0;
  let stoppedBy: ContextDependentsPage["scan"]["stoppedBy"];
  let nextOffset = offset;
  for (; nextOffset < inventory.length; nextOffset += 1) {
    if (options.signal?.aborted) throw new Error("Context dependents search was cancelled");
    if (Date.now() >= deadline) { stoppedBy = "timeout"; break; }
    if (pathsExamined >= Math.max(1, options.maxScanFiles)) { stoppedBy = "fileLimit"; break; }
    const candidate = inventory[nextOffset];
    pathsExamined += 1;
    if (candidate === undefined || candidate === target) continue;
    let specifiers: string[];
    const resident = index.files.get(candidate);
    if (resident) {
      specifiers = dependencySpecifiers(resident);
    } else {
      let sourceInfo: { absolutePath: string; size: number; mtimeMs: number };
      try { sourceInfo = await resolveContextSource(index.workspaceRoot, candidate, index.allowedPaths); } catch { continue; }
      if (sourceInfo.size > Math.max(1, options.maxFileScanBytes)) continue;
      if (bytesScanned + sourceInfo.size > Math.max(1, options.maxScanBytes)) { stoppedBy = "byteLimit"; break; }
      const text = await readContextText(sourceInfo.absolutePath, options.signal, deadline);
      bytesScanned += Buffer.byteLength(text, "utf8");
      filesScanned += 1;
      const preprocessed = ts.preProcessFile(text, true, true);
      specifiers = [...preprocessed.importedFiles, ...preprocessed.referencedFiles].map((entry) => String(entry.fileName));
    }
    const matched = [...new Set(specifiers.filter((specifier) => resolveIndexedImport(index, candidate, specifier) === target))];
    if (matched.length > 0) {
      results.push({ path: candidate, specifiers: matched.sort() });
      if (results.length >= maxResults) { nextOffset += 1; stoppedBy = "resultLimit"; break; }
    }
  }
  const exhausted = nextOffset >= inventory.length;
  return {
    results,
    ...(exhausted ? {} : { nextCursor: `v1:${cursorHash}:${String(nextOffset)}` }),
    scan: {
      pathsExamined,
      filesScanned,
      bytesScanned,
      elapsedMs: Date.now() - started,
      exhausted,
      ...(stoppedBy ? { stoppedBy } : {}),
    },
  };
};

const dependencyReasons = (
  index: ContextIndex,
  roots: Array<{ file: SourceFileIndex; score: number }>,
  maxDepth = 2,
): Map<string, { score: number; reason: string[] }> => {
  const values = new Map<string, { score: number; reason: string[] }>();
  const queue = roots.slice(0, 12).map((entry) => ({ ...entry, depth: 0 }));
  const visited = new Set(queue.map((entry) => entry.file.path));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= Math.max(0, maxDepth)) continue;
    const specifiers = [...current.file.imports.map((entry) => entry.specifier), ...current.file.reExports];
    for (const specifier of specifiers) {
      const resolved = resolveIndexedImport(index, current.file.path, specifier);
      if (!resolved) continue;
      const score = Math.max(8, current.score - 18 - current.depth * 8);
      const existing = values.get(resolved);
      const reason = `dependency-of:${current.file.path}`;
      if (!existing || score > existing.score) values.set(resolved, { score, reason: [reason] });
      else if (!existing.reason.includes(reason)) existing.reason.push(reason);
      if (!visited.has(resolved)) {
        visited.add(resolved);
        const file = index.files.get(resolved);
        if (file) queue.push({ file, score, depth: current.depth + 1 });
      }
    }
  }
  return values;
};

const bestWindowRange = (file: SourceFileIndex, query: string, maxLines: number): readonly [number, number] => {
  const lines = file.text.split(/\r?\n/);
  if (lines.length <= maxLines) return [1, lines.length];
  const normalizedQuery = normalizedSearchPhrase(query);
  const tokens = tokenize(query);
  const scores = lines.map((line) => {
    const value = line.toLowerCase();
    let score = normalizedQuery && value.includes(normalizedQuery) ? 100 : 0;
    for (const token of tokens) if (value.includes(token)) score += 8;
    return score;
  });
  let current = scores.slice(0, maxLines).reduce((total, value) => total + value, 0);
  let best = current;
  let bestStart = 0;
  for (let start = 1; start + maxLines <= lines.length; start += 1) {
    current += (scores[start + maxLines - 1] ?? 0) - (scores[start - 1] ?? 0);
    if (current > best) {
      best = current;
      bestStart = start;
    }
  }
  return [bestStart + 1, bestStart + maxLines];
};

const snippetId = (file: SourceFileIndex, startLine: number, endLine: number): string =>
  hashText(`${file.path}:${file.sha256}:${startLine}:${endLine}`).slice(0, 16);

const makeSnippet = (file: SourceFileIndex, startLine: number, endLine: number, reason: string[]): ContextSnippet => {
  const lines = file.text.split(/\r?\n/);
  const safeStart = Math.max(1, startLine);
  const safeEnd = Math.min(lines.length, Math.max(safeStart, endLine));
  return {
    id: snippetId(file, safeStart, safeEnd),
    path: file.path,
    startLine: safeStart,
    endLine: safeEnd,
    sha256: file.sha256,
    hashScope: "file",
    fileVersion: file.version,
    reason,
    text: lines.slice(safeStart - 1, safeEnd).join("\n"),
  };
};

export const selectInitialContext = (index: ContextIndex, input: {
  task: string;
  changedFiles?: string[];
  seedFiles?: string[];
  errorText?: string;
  dependencyDepth?: number;
  maxBytes?: number;
  maxSnippets?: number;
}): { snippets: ContextSnippet[]; omitted: Array<{ path: string; score: number; reason: string[] }>; omittedTotal: number } => {
  const changedFiles = new Set((input.changedFiles ?? []).map(normalizePath));
  const seedFiles = new Set((input.seedFiles ?? []).map(normalizePath));
  const errorText = input.errorText ?? "";
  const direct = Array.from(index.files.values())
    .map((file) => ({ file, ...scoreFile(file, { task: input.task, changedFiles, seedFiles, errorText }) }))
    .filter((entry) => entry.score > 0);
  const dependencies = dependencyReasons(index, direct.sort((left, right) => right.score - left.score), input.dependencyDepth ?? 2);
  const rankedByPath = new Map<string, { file: SourceFileIndex; score: number; reason: string[] }>();
  direct.forEach((entry) => rankedByPath.set(entry.file.path, entry));
  dependencies.forEach((value, filePath) => {
    const file = index.files.get(filePath);
    if (!file) return;
    const existing = rankedByPath.get(filePath);
    if (!existing) rankedByPath.set(filePath, { file, score: value.score, reason: value.reason });
    else {
      existing.score = Math.max(existing.score, value.score);
      existing.reason = [...new Set([...existing.reason, ...value.reason])];
    }
  });
  const ranked = Array.from(rankedByPath.values())
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const snippets: ContextSnippet[] = [];
  const omitted: Array<{ path: string; score: number; reason: string[] }> = [];
  let bytes = 0;
  const taskTokens = tokenize(input.task);
  for (const entry of ranked) {
    const declarations = entry.file.declarations.filter((declaration) => taskTokens.includes(declaration.name.toLowerCase()));
    const wholeFile = Buffer.byteLength(entry.file.text, "utf8") <= WHOLE_FILE_SNIPPET_MAX_BYTES;
    const ranges: Array<readonly [number, number]> = wholeFile
      ? [[1, entry.file.text.split(/\r?\n/).length]]
      : declarations.length > 0
        ? declarations.map((declaration) => [Math.max(1, declaration.startLine - 4), declaration.endLine + 8] as const)
        : [bestWindowRange(entry.file, input.task, 240)];
    let included = false;
    for (const [startLine, endLine] of ranges) {
      const snippet = makeSnippet(entry.file, startLine, endLine, entry.reason);
      const size = Buffer.byteLength(snippet.text, "utf8");
      if (snippets.length >= (input.maxSnippets ?? 24) || bytes + size > (input.maxBytes ?? 96 * 1024)) break;
      snippets.push(snippet);
      bytes += size;
      included = true;
    }
    if (!included) omitted.push({ path: entry.file.path, score: entry.score, reason: entry.reason });
  }
  return { snippets, omitted: omitted.slice(0, 50), omittedTotal: omitted.length };
};

export type ContextRefreshResult = {
  timedOut: boolean;
};

export type ContextRefreshOptions = {
  fillOnly?: boolean;
};

export const refreshContextFiles = async (
  index: ContextIndex,
  changedFiles: string[],
  signal?: AbortSignal,
  deadlineAt?: number,
  options: ContextRefreshOptions = {},
): Promise<ContextRefreshResult> => {
  if (signal?.aborted) throw new Error("Context refresh was cancelled");
  deadlineAt ??= Date.now() + Math.max(1, index.indexingTimeoutMs || 30_000);
  let refreshTimedOut = false;
  index.revision += 1;
  contextSearchPlanCache.delete(index);
  const normalizedPathSet = new Set(changedFiles.map(normalizePath).map(normalizeWorkspaceRelativePath));
  const normalizedPaths = [...normalizedPathSet];
  const requestedPaths = new Set(normalizedPaths);
  const fillOnlyPaths = new Set<string>();
  let currentBytes = Array.from(index.files.values())
    .reduce((total, file) => total + Buffer.byteLength(file.text, "utf8"), 0);
  const removeResident = (relativePath: string): SourceFileIndex | undefined => {
    const current = index.files.get(relativePath);
    if (current) {
      currentBytes -= Buffer.byteLength(current.text, "utf8");
      index.files.delete(relativePath);
    }
    return current;
  };
  const ignoreMetadataChanged = normalizedPaths.some((relativePath) => {
    const basename = path.posix.basename(relativePath);
    return basename === ".gitignore" || basename === ".ignore";
  });
  if (ignoreMetadataChanged) {
    const remainingInventoryMs = deadlineAt === undefined
      ? index.inventoryTimeoutMs
      : Math.max(0, deadlineAt - Date.now());
    if (remainingInventoryMs <= 0) {
      refreshTimedOut = true;
      index.coverage.indexingTimedOut = true;
      throw new Error("Context refresh deadline expired while repository ignore rules changed");
    }
    const inventoryResult = await collectInventory(
      index.workspaceRoot,
      index.allowedPaths,
      index.coverage.maxInventoryFiles,
      Math.min(index.inventoryTimeoutMs, remainingInventoryMs),
      signal,
    );
    if (inventoryResult.truncated) {
      index.coverage.inventoryTruncated = true;
      index.coverage.inventoryTimedOut = inventoryResult.timedOut;
      setOptionalProperty(index.coverage, "inventoryTruncationReason", inventoryResult.truncationReason);
      throw new Error("Context inventory became incomplete while repository ignore rules changed");
    }
    for (const relativePath of inventoryResult.entries) {
      if (!index.inventory.has(relativePath) && !normalizedPathSet.has(relativePath)) {
        normalizedPathSet.add(relativePath);
        normalizedPaths.push(relativePath);
        fillOnlyPaths.add(relativePath);
      }
    }
    index.inventory = new Set(inventoryResult.entries);
    index.ignoreScopes = inventoryResult.ignoreScopes.map((scope) => ({ directory: scope.directory, rules: [...scope.rules] }));
    index.coverage.inventoryTruncated = false;
    index.coverage.inventoryTimedOut = false;
    delete index.coverage.inventoryTruncationReason;
    index.coverage.ignoreFileCount = inventoryResult.ignoreFileCount;
    for (const relativePath of [...index.files.keys()]) {
      if (!index.inventory.has(relativePath)) removeResident(relativePath);
    }
    for (const set of [
      index.skippedTooLargePaths,
      index.skippedUnreadablePaths,
      index.skippedBudgetPaths,
      index.skippedFileLimitPaths,
    ]) {
      for (const relativePath of [...set]) {
        if (!index.inventory.has(relativePath)) set.delete(relativePath);
      }
    }
  }
  if (normalizedPaths.some((value) => /(?:^|\/)(?:tsconfig|jsconfig)\.json$/u.test(value))) {
    compilerOptionsByDirectory.delete(index);
  }
  if (normalizedPaths.some((value) => /(?:^|\/)package\.json$/u.test(value))) {
    workspacePackagesByIndex.delete(index);
  }
  if (normalizedPaths.some((value) => value === "tsconfig.json" || value === "jsconfig.json")) {
    index.compilerOptions = loadCompilerOptions(index.workspaceRoot);
  }
  const { tsMorph, ignore } = loadLibraries();
  const ignoreFactory: IgnoreFactory = ignore.default ?? ignore;
  const compiledIgnoreScopes = index.ignoreScopes.map((scope) => compileContextIgnoreScope(scope, ignoreFactory));
  const builtInIgnoreMatcher = ignoreFactory().add(builtInIgnoreRules);
  const project = new tsMorph.Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: index.compilerOptions });
  for (let pathIndex = 0; pathIndex < normalizedPaths.length; pathIndex += 1) {
    const normalizedPath = normalizedPaths[pathIndex];
    // The loop bound proves the entry is there; the guard is what the compiler can read.
    if (normalizedPath === undefined) continue;
    if (signal?.aborted) throw new Error("Context refresh was cancelled");
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      refreshTimedOut = true;
      for (const remainingPath of normalizedPaths.slice(pathIndex)) {
        if (!index.inventory.has(remainingPath)) continue;
        removeResident(remainingPath);
        index.skippedBudgetPaths.add(remainingPath);
      }
      break;
    }
    if (pathIndex > 0 && pathIndex % 32 === 0) await yieldContextWork();
    const fillOnlyPath = options.fillOnly || fillOnlyPaths.has(normalizedPath);
    if (fillOnlyPath
      && !index.files.has(normalizedPath)
      && (index.files.size >= index.coverage.maxFiles || currentBytes >= index.coverage.maxTotalBytes)) {
      break;
    }
    if (normalizedPath === "."
      || isRestrictedWorkspacePath(normalizedPath)
      || !isSupportedContextPath(normalizedPath)
      || contextPathIgnored(normalizedPath, false, compiledIgnoreScopes, builtInIgnoreMatcher)) {
      index.inventory.delete(normalizedPath);
      removeResident(normalizedPath);
      index.skippedTooLargePaths.delete(normalizedPath);
      index.skippedUnreadablePaths.delete(normalizedPath);
      index.skippedBudgetPaths.delete(normalizedPath);
      index.skippedFileLimitPaths.delete(normalizedPath);
      continue;
    }
    try {
      const source = await resolveContextSource(index.workspaceRoot, normalizedPath, index.allowedPaths);
      index.inventory.add(normalizedPath);
      index.skippedUnreadablePaths.delete(normalizedPath);
      index.skippedBudgetPaths.delete(normalizedPath);
      index.skippedFileLimitPaths.delete(normalizedPath);
      const previous = index.files.get(normalizedPath);
      if (source.size > index.coverage.maxFileBytes) {
        removeResident(normalizedPath);
        index.skippedTooLargePaths.add(normalizedPath);
        continue;
      }
      index.skippedTooLargePaths.delete(normalizedPath);
      if (fillOnlyPath
        && !previous
        && currentBytes + source.size > index.coverage.maxTotalBytes) {
        index.skippedBudgetPaths.add(normalizedPath);
        continue;
      }
      const nextFile = await indexFile(
        project,
        index.workspaceRoot,
        normalizedPath,
        Math.max((previous?.version ?? 0) + 1, index.revision),
        index.allowedPaths,
        signal,
        deadlineAt,
      );
      const nextBytes = Buffer.byteLength(nextFile.text, "utf8");
      if (nextBytes > index.coverage.maxFileBytes) {
        removeResident(normalizedPath);
        index.skippedTooLargePaths.add(normalizedPath);
        continue;
      }
      if (!previous && index.files.size >= index.coverage.maxFiles) {
        if (fillOnlyPath) {
          index.skippedFileLimitPaths.add(normalizedPath);
          continue;
        }
        const victim = Array.from(index.files.values())
          .filter((file) => file.path !== normalizedPath)
          .sort((left, right) => {
            const leftProtected = requestedPaths.has(left.path) ? 1 : 0;
            const rightProtected = requestedPaths.has(right.path) ? 1 : 0;
            return leftProtected - rightProtected
              || left.version - right.version
              || left.path.localeCompare(right.path);
          })[0];
        if (victim) {
          removeResident(victim.path);
          index.skippedFileLimitPaths.add(victim.path);
        }
      }
      const previousBytes = previous && index.files.has(normalizedPath)
        ? Buffer.byteLength(previous.text, "utf8")
        : 0;
      let projectedBytes = currentBytes - previousBytes + nextBytes;
      if (projectedBytes > index.coverage.maxTotalBytes && fillOnlyPath) {
        removeResident(normalizedPath);
        index.skippedBudgetPaths.add(normalizedPath);
        continue;
      }
      if (projectedBytes > index.coverage.maxTotalBytes) {
        const victims = Array.from(index.files.values())
          .filter((file) => file.path !== normalizedPath && !requestedPaths.has(file.path))
          .sort((left, right) => left.version - right.version || left.path.localeCompare(right.path));
        for (const victim of victims) {
          if (projectedBytes <= index.coverage.maxTotalBytes) break;
          removeResident(victim.path);
          projectedBytes = currentBytes - previousBytes + nextBytes;
          index.skippedBudgetPaths.add(victim.path);
        }
      }
      if (projectedBytes > index.coverage.maxTotalBytes) {
        removeResident(normalizedPath);
        index.skippedBudgetPaths.add(normalizedPath);
        continue;
      }
      if (previous && index.files.has(normalizedPath)) removeResident(normalizedPath);
      index.files.set(normalizedPath, nextFile);
      currentBytes += nextBytes;
      index.skippedFileLimitPaths.delete(normalizedPath);
    } catch (error) {
      if (signal?.aborted) throw new Error("Context refresh was cancelled");
      if (error instanceof Error && error.message === contextIndexDeadlineMessage) {
        refreshTimedOut = true;
        for (const remainingPath of normalizedPaths.slice(pathIndex)) {
          if (!index.inventory.has(remainingPath)) continue;
          removeResident(remainingPath);
          index.skippedBudgetPaths.add(remainingPath);
        }
        break;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        index.inventory.delete(normalizedPath);
        removeResident(normalizedPath);
        index.skippedTooLargePaths.delete(normalizedPath);
        index.skippedUnreadablePaths.delete(normalizedPath);
        index.skippedBudgetPaths.delete(normalizedPath);
        index.skippedFileLimitPaths.delete(normalizedPath);
      } else {
        index.inventory.add(normalizedPath);
        removeResident(normalizedPath);
        index.skippedUnreadablePaths.add(normalizedPath);
      }
    }
  }
  for (const relativePath of [...index.skippedFileLimitPaths]) {
    if (!index.inventory.has(relativePath) || index.files.has(relativePath)) {
      index.skippedFileLimitPaths.delete(relativePath);
    }
  }
  let inventoryIndex = 0;
  for (const relativePath of index.inventory) {
    if (signal?.aborted) throw new Error("Context refresh was cancelled");
    if (inventoryIndex > 0 && inventoryIndex % 512 === 0) await yieldContextWork();
    inventoryIndex += 1;
    if (!index.files.has(relativePath)
      && !index.skippedTooLargePaths.has(relativePath)
      && !index.skippedUnreadablePaths.has(relativePath)
      && !index.skippedBudgetPaths.has(relativePath)) {
      index.skippedFileLimitPaths.add(relativePath);
    }
  }
  index.coverage.inventoryCount = index.inventory.size;
  index.coverage.indexedCount = index.files.size;
  index.coverage.indexedBytes = Math.max(0, currentBytes);
  index.coverage.skippedTooLarge = index.skippedTooLargePaths.size;
  index.coverage.skippedUnreadable = index.skippedUnreadablePaths.size;
  index.coverage.skippedBudget = index.skippedBudgetPaths.size;
  index.coverage.skippedFileLimit = index.skippedFileLimitPaths.size;
  index.coverage.indexingTimedOut = index.coverage.indexingTimedOut || refreshTimedOut;
  index.coverage.truncated = index.coverage.inventoryTruncated
    || index.coverage.indexingTimedOut
    || index.files.size < index.inventory.size
    || index.skippedTooLargePaths.size > 0
    || index.skippedUnreadablePaths.size > 0
    || index.skippedBudgetPaths.size > 0
    || index.skippedFileLimitPaths.size > 0;
  return { timedOut: refreshTimedOut };
};

export type ContextSearchPage = {
  snippets: ContextSnippet[];
  nextCursor?: string;
  scan: {
    pathsExamined: number;
    filesScanned: number;
    bytesScanned: number;
    skippedTooLarge: number;
    elapsedMs: number;
    exhausted: boolean;
    stoppedBy?: "fileLimit" | "byteLimit" | "timeout" | "resultLimit";
  };
};

type ContextSearchCursorState = {
  residentOffset: number;
  omittedOffset: number;
};

const contextSearchCursorHash = (revision: number, query: string, prefix: string): string =>
  hashText(`${String(revision)}\0${query}\0${prefix}`).slice(0, 12);


const contextPathSearchScore = (
  relativePath: string,
  normalizedQuery: string,
  tokens: string[],
): number => {
  const normalizedPath = relativePath.toLowerCase();
  const basename = path.posix.basename(normalizedPath);
  let score = 0;
  if (normalizedQuery && normalizedPath === normalizedQuery) score += 4_000;
  else if (normalizedQuery && basename === normalizedQuery) score += 3_000;
  else if (normalizedQuery && normalizedPath.includes(normalizedQuery)) score += 1_000;
  for (const token of tokens) {
    if (basename === token) score += 500;
    else if (basename.includes(token)) score += 180;
    else if (normalizedPath.includes(token)) score += 40;
  }
  return score;
};

const prepareContextSearchPlan = async (
  index: ContextIndex,
  query: string,
  prefix: string,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<ContextSearchPlan> => {
  const key = JSON.stringify([index.revision, query, prefix]);
  const cache = contextSearchPlanCache.get(index) ?? new Map<string, ContextSearchPlan>();
  contextSearchPlanCache.set(index, cache);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const eligiblePath = (relativePath: string): boolean =>
    !prefix || relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  const normalizedQuery = normalizedSearchPhrase(query);
  const queryTokens = tokenize(query);
  const residentRanked: ContextSearchPlan["residentRanked"] = [];
  let residentProcessed = 0;
  for (const file of index.files.values()) {
    if (!eligiblePath(file.path)) continue;
    if (signal?.aborted) throw new Error("Context search was cancelled");
    if (Date.now() >= deadlineAt) throw new Error("Context search timed out while ranking the resident index");
    if (residentProcessed > 0 && residentProcessed % 64 === 0) await yieldContextWork();
    residentProcessed += 1;
    const scored = scoreFile(file, { task: query, taskTokens: queryTokens, changedFiles: new Set<string>(), seedFiles: new Set<string>(), errorText: "" });
    if (scored.score > 0 || fileContains(file, normalizedQuery, true)) residentRanked.push({ file, ...scored });
  }
  residentRanked.sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const omittedRanked: Array<{ path: string; score: number }> = [];
  let omittedProcessed = 0;
  for (const relativePath of index.inventory) {
    if (index.files.has(relativePath) || !eligiblePath(relativePath)) continue;
    if (signal?.aborted) throw new Error("Context search was cancelled");
    if (Date.now() >= deadlineAt) throw new Error("Context search timed out while preparing omitted-file pagination");
    if (omittedProcessed > 0 && omittedProcessed % 512 === 0) await yieldContextWork();
    omittedProcessed += 1;
    omittedRanked.push({
      path: relativePath,
      score: contextPathSearchScore(relativePath, normalizedQuery, queryTokens),
    });
  }
  omittedRanked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const plan = {
    residentRanked,
    omittedPaths: omittedRanked.map((entry) => entry.path),
    normalizedQuery,
    queryTokens,
  };
  cache.set(key, plan);
  while (cache.size > maximumCachedContextSearchPlans) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return plan;
};

const contextSearchCursor = (
  revision: number,
  query: string,
  prefix: string,
  residentOffset: number,
  omittedOffset: number,
): string => `v2:${contextSearchCursorHash(revision, query, prefix)}:${String(residentOffset)}:${String(omittedOffset)}`;

const parseContextSearchCursor = (
  revision: number,
  query: string,
  prefix: string,
  cursor?: string,
): ContextSearchCursorState => {
  if (!cursor) return { residentOffset: 0, omittedOffset: 0 };
  const expectedHash = contextSearchCursorHash(revision, query, prefix);
  const current = /^v2:([a-f0-9]{12}):(\d+):(\d+)$/i.exec(cursor);
  if (current) {
    if ((current[1] ?? "").toLowerCase() !== expectedHash) {
      throw new Error("Context search cursor does not match this index revision, query, and path prefix");
    }
    const residentOffset = Number(current[2]);
    const omittedOffset = Number(current[3]);
    if (!Number.isSafeInteger(residentOffset) || residentOffset < 0
      || !Number.isSafeInteger(omittedOffset) || omittedOffset < 0) {
      throw new Error("Context search cursor is invalid");
    }
    return { residentOffset, omittedOffset };
  }
  const legacy = /^v1:([a-f0-9]{12}):(\d+)$/i.exec(cursor);
  if (!legacy || (legacy[1] ?? "").toLowerCase() !== expectedHash) {
    throw new Error("Context search cursor does not match this index revision, query, and path prefix");
  }
  const omittedOffset = Number(legacy[2]);
  if (!Number.isSafeInteger(omittedOffset) || omittedOffset < 0) {
    throw new Error("Context search cursor is invalid");
  }
  return { residentOffset: Number.MAX_SAFE_INTEGER, omittedOffset };
};


const safeSearchSlice = (value: string, start: number, end: number): string => {
  let safeStart = Math.max(0, Math.min(start, value.length));
  let safeEnd = Math.max(safeStart, Math.min(end, value.length));
  if (safeStart > 0) {
    const code = value.charCodeAt(safeStart);
    if (code >= 0xdc00 && code <= 0xdfff) safeStart -= 1;
  }
  if (safeEnd > 0 && safeEnd < value.length) {
    const code = value.charCodeAt(safeEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) safeEnd -= 1;
  }
  return value.slice(safeStart, safeEnd);
};

const boundedSearchSnippet = (
  file: SourceFileIndex,
  query: string,
  reason: string[],
  maxBytes: number,
): ContextSnippet | undefined => {
  if (maxBytes < 64) return undefined;
  const [startLine, endLine] = bestWindowRange(file, query, 160);
  const full = makeSnippet(file, startLine, endLine, reason);
  if (Buffer.byteLength(full.text, "utf8") <= maxBytes) return full;
  const lines = file.text.split(/\r?\n/);
  const normalizedQuery = normalizedSearchPhrase(query);
  const tokens = tokenize(query);
  let bestLine = Math.max(0, startLine - 1);
  let bestScore = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const value = (lines[index] ?? "").toLowerCase();
    let score = normalizedQuery && value.includes(normalizedQuery) ? 100 : 0;
    for (const token of tokens) if (value.includes(token)) score += 8;
    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  }
  const line = lines[bestLine] ?? "";
  if (Buffer.byteLength(line, "utf8") <= maxBytes) {
    return makeSnippet(file, bestLine + 1, bestLine + 1, [...reason, "search-window-truncated"]);
  }
  const normalizedLine = line.toLowerCase();
  const matchIndex = normalizedQuery ? normalizedLine.indexOf(normalizedQuery) : -1;
  const tokenIndex = matchIndex >= 0 ? matchIndex : tokens.reduce((found, token) => {
    if (found >= 0) return found;
    return normalizedLine.indexOf(token);
  }, -1);
  const center = tokenIndex >= 0 ? tokenIndex : 0;
  let low = 1;
  let high = line.length;
  let excerpt = "";
  while (low <= high) {
    const width = Math.floor((low + high) / 2);
    const start = Math.max(0, Math.min(center - Math.floor(width / 3), line.length - width));
    const value = safeSearchSlice(line, start, start + width);
    const decorated = `${start > 0 ? "…" : ""}${value}${start + width < line.length ? "…" : ""}`;
    if (Buffer.byteLength(decorated, "utf8") <= maxBytes) {
      excerpt = decorated;
      low = width + 1;
    } else {
      high = width - 1;
    }
  }
  if (!excerpt) return undefined;
  return {
    id: hashText(`${file.path}:${file.sha256}:${String(bestLine + 1)}:${excerpt}`).slice(0, 16),
    path: file.path,
    startLine: bestLine + 1,
    endLine: bestLine + 1,
    sha256: file.sha256,
    hashScope: "file",
    fileVersion: file.version,
    reason: [...reason, "search-excerpt-truncated"],
    text: excerpt,
    textTruncated: true,
  };
};

export const searchContextIndexPage = async (index: ContextIndex, input: {
  query: string;
  pathPrefix?: string;
  cursor?: string;
  maxBytes?: number;
  maxSnippets?: number;
  maxScanFiles?: number;
  maxScanBytes?: number;
  maxFileScanBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ContextSearchPage> => {
  const started = Date.now();
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 15_000);
  const deadline = started + timeoutMs;
  const maxScanFiles = Math.max(1, input.maxScanFiles ?? 5_000);
  const maxScanBytes = Math.max(1, input.maxScanBytes ?? 64 * 1024 * 1024);
  const maxFileScanBytes = Math.max(1, input.maxFileScanBytes ?? 8 * 1024 * 1024);
  const outputBytes = Math.max(64, input.maxBytes ?? 48 * 1024);
  const outputSnippets = Math.max(1, input.maxSnippets ?? 12);
  const perSnippetBytes = Math.max(64, Math.min(12 * 1024, Math.floor(outputBytes / outputSnippets)));
  let prefix = "";
  if (input.pathPrefix) {
    try {
      const normalizedPrefix = normalizeWorkspaceRelativePath(input.pathPrefix);
      if (normalizedPrefix !== "." && isRestrictedWorkspacePath(normalizedPrefix)) {
        return {
          snippets: [],
          scan: { pathsExamined: 0, filesScanned: 0, bytesScanned: 0, skippedTooLarge: 0, elapsedMs: Date.now() - started, exhausted: true },
        };
      }
      prefix = normalizedPrefix === "." ? "" : normalizePath(normalizedPrefix).replace(/\/+$/, "");
    } catch {
      return {
        snippets: [],
        scan: { pathsExamined: 0, filesScanned: 0, bytesScanned: 0, skippedTooLarge: 0, elapsedMs: Date.now() - started, exhausted: true },
      };
    }
  }
  const cursor = parseContextSearchCursor(index.revision, input.query, prefix, input.cursor);
  const { residentRanked, omittedPaths, normalizedQuery, queryTokens } = await prepareContextSearchPlan(
    index,
    input.query,
    prefix,
    deadline,
    input.signal,
  );
  let residentOffset = cursor.residentOffset === Number.MAX_SAFE_INTEGER ? residentRanked.length : cursor.residentOffset;
  let omittedOffset = cursor.omittedOffset;
  if (residentOffset > residentRanked.length || omittedOffset > omittedPaths.length) {
    throw new Error("Context search cursor is invalid for the current index");
  }
  let pathsExamined = 0;
  let filesScanned = 0;
  let bytesScanned = 0;
  let skippedTooLarge = 0;
  let stoppedBy: ContextSearchPage["scan"]["stoppedBy"];
  const snippets: ContextSnippet[] = [];
  let bytes = 0;
  const appendSnippet = (file: SourceFileIndex, reason: string[]): boolean => {
    if (snippets.length >= outputSnippets) return false;
    const remaining = outputBytes - bytes;
    if (remaining < 64) return false;
    const snippet = boundedSearchSnippet(file, input.query, reason, Math.min(remaining, perSnippetBytes));
    if (!snippet) return false;
    const size = Buffer.byteLength(snippet.text, "utf8");
    snippets.push(snippet);
    bytes += size;
    return true;
  };

  const hasOmitted = omittedOffset < omittedPaths.length;
  const residentQuota = hasOmitted ? Math.max(1, Math.floor(outputSnippets / 2)) : outputSnippets;
  let residentAdded = 0;
  while (residentOffset < residentRanked.length && residentAdded < residentQuota && snippets.length < outputSnippets) {
    if (outputBytes - bytes < 64) break;
    const entry = residentRanked[residentOffset];
    // The loop bound proves the entry is there.
    if (entry && appendSnippet(entry.file, [...entry.reason, "context-search"])) residentAdded += 1;
    residentOffset += 1;
  }

  while (omittedOffset < omittedPaths.length) {
    if (snippets.length >= outputSnippets || outputBytes - bytes < 64) {
      stoppedBy = "resultLimit";
      break;
    }
    if (input.signal?.aborted) throw new Error("Context search was cancelled");
    if (Date.now() >= deadline) {
      stoppedBy = "timeout";
      break;
    }
    if (pathsExamined >= maxScanFiles) {
      stoppedBy = "fileLimit";
      break;
    }
    const relativePath = omittedPaths[omittedOffset];
    pathsExamined += 1;
    if (relativePath === undefined) {
      omittedOffset += 1;
      continue;
    }
    try {
      const source = await resolveContextSource(index.workspaceRoot, relativePath, index.allowedPaths);
      if (source.size <= 0) {
        omittedOffset += 1;
        continue;
      }
      if (source.size > maxFileScanBytes || source.size > maxScanBytes) {
        skippedTooLarge += 1;
        omittedOffset += 1;
        continue;
      }
      if (bytesScanned + source.size > maxScanBytes) {
        stoppedBy = "byteLimit";
        break;
      }
      if (Date.now() >= deadline) {
        stoppedBy = "timeout";
        break;
      }
      const readController = new AbortController();
      let readTimedOut = false;
      const abortRead = (): void => readController.abort();
      input.signal?.addEventListener("abort", abortRead, { once: true });
      const readTimeout = setTimeout(() => {
        readTimedOut = true;
        readController.abort();
      }, Math.max(1, deadline - Date.now()));
      let text: string;
      try {
        text = await fs.readFile(source.absolutePath, { encoding: "utf8", signal: readController.signal });
      } catch (error) {
        if (input.signal?.aborted) throw new Error("Context search was cancelled");
        if (readTimedOut) {
          stoppedBy = "timeout";
          break;
        }
        throw error;
      } finally {
        clearTimeout(readTimeout);
        input.signal?.removeEventListener("abort", abortRead);
      }
      filesScanned += 1;
      bytesScanned += source.size;
      omittedOffset += 1;
      if (text.includes("\0")) continue;
      const file = plainFileIndex(relativePath, text, index.revision, source.size, source.mtimeMs);
      const scored = scoreFile(file, {
        task: input.query,
        taskTokens: queryTokens,
        changedFiles: new Set<string>(),
        seedFiles: new Set<string>(),
        errorText: "",
      });
      if (scored.score <= 0 && !fileContains(file, normalizedQuery, true)) continue;
      if (!appendSnippet(file, [...scored.reason, "context-search"])) {
        stoppedBy = "resultLimit";
        break;
      }
      if (snippets.length >= outputSnippets || outputBytes - bytes < 64) {
        if (residentOffset < residentRanked.length || omittedOffset < omittedPaths.length) stoppedBy = "resultLimit";
        break;
      }
    } catch (error) {
      if (input.signal?.aborted) throw new Error("Context search was cancelled");
      omittedOffset += 1;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") index.skippedUnreadablePaths.add(relativePath);
    }
  }

  const exhausted = residentOffset >= residentRanked.length && omittedOffset >= omittedPaths.length;
  return {
    snippets,
    ...(!exhausted ? { nextCursor: contextSearchCursor(index.revision, input.query, prefix, residentOffset, omittedOffset) } : {}),
    scan: {
      pathsExamined,
      filesScanned,
      bytesScanned,
      skippedTooLarge,
      elapsedMs: Date.now() - started,
      exhausted,
      ...(stoppedBy ? { stoppedBy } : {}),
    },
  };
};

export const searchContextIndex = async (index: ContextIndex, input: {
  query: string;
  pathPrefix?: string;
  maxBytes?: number;
  maxSnippets?: number;
  signal?: AbortSignal;
}): Promise<ContextSnippet[]> => (await searchContextIndexPage(index, input)).snippets;

function fileContains(file: SourceFileIndex, query: string, normalized = false): boolean {
  const value = normalized ? query : normalizedSearchPhrase(query);
  return value.length > 0 && (
    file.path.toLowerCase().includes(value)
    || file.text.toLowerCase().includes(value)
  );
}

export type ContextSyntaxDiagnostic = {
  path: string;
  message: string;
  line?: number;
};

export type ContextSyntaxCheckResult = {
  diagnostics: ContextSyntaxDiagnostic[];
  checkedPaths: string[];
  skippedPaths: string[];
};

const syntaxCheckPath = (value: string): boolean => {
  const extension = path.extname(value).toLowerCase();
  return tsJsExtensions.has(extension) || extension === ".json";
};

export const collectContextSyntaxCheck = (
  index: ContextIndex,
  paths?: readonly string[],
): ContextSyntaxCheckResult => {
  const requested = paths && paths.length > 0
    ? [...new Set(paths.map(normalizePath))].filter(syntaxCheckPath)
    : Array.from(index.files.keys()).filter(syntaxCheckPath);
  const selected: SourceFileIndex[] = [];
  const skippedPaths: string[] = [];
  for (const requestedPath of requested) {
    const file = index.files.get(requestedPath);
    if (file) selected.push(file);
    else skippedPaths.push(requestedPath);
  }
  const diagnostics: ContextSyntaxDiagnostic[] = [];
  const checkedPaths: string[] = [];
  const { tsMorph } = loadLibraries();
  const ts = tsMorph.ts;
  for (const file of selected) {
    const extension = path.extname(file.path).toLowerCase();
    checkedPaths.push(file.path);
    if (tsJsExtensions.has(extension)) {
      const scriptKind = extension === ".tsx"
        ? ts.ScriptKind.TSX
        : extension === ".jsx"
          ? ts.ScriptKind.JSX
          : extension === ".js" || extension === ".mjs" || extension === ".cjs"
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
      const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind) as ParsedSourceFile;
      for (const diagnostic of source.parseDiagnostics ?? []) {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
        const position = typeof diagnostic.start === "number" ? source.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
        diagnostics.push({
          path: file.path,
          message,
          ...(position ? { line: position.line + 1 } : {}),
        });
      }
      continue;
    }
    try {
      JSON.parse(file.text);
    } catch (error) {
      diagnostics.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    diagnostics: diagnostics.slice(0, 100),
    checkedPaths: checkedPaths.sort(),
    skippedPaths: skippedPaths.sort(),
  };
};

export const collectContextSyntaxDiagnostics = (
  index: ContextIndex,
  paths?: readonly string[],
): ContextSyntaxDiagnostic[] => collectContextSyntaxCheck(index, paths).diagnostics;
