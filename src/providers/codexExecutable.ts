/**
 * Which Codex binary answers for `codex` on this machine.
 *
 * A machine can hold several Codex builds at once: an older standalone CLI on the PATH, and newer
 * ones shipped inside installed OpenAI VS Code extensions. They are not interchangeable. A current
 * model such as `gpt-6-astra` is refused by an older client with "requires a newer version of
 * Codex", which reads as a Bachata fault and is not one — Bachata simply started the first `codex`
 * the PATH offered.
 *
 * So when the executable setting is still the untouched default, the Codex bundled with the OpenAI
 * extension *this extension host has loaded* is preferred over anything else. An explicitly
 * configured command is never second-guessed: a reader who names a path has stated which build they
 * want, and silently running a different one would be worse than running an old one.
 *
 * The trees are not interchangeable either. `.vscode`, `.vscode-insiders`, `.vscode-server` and
 * `.vscode-server-insiders` belong to different hosts, and on macOS and Linux every target's binary
 * is called `codex`, so picking whichever directory carried the highest version could hand an
 * ARM macOS host an x64 or Linux binary from a tree it does not run in. A candidate is therefore
 * only usable when it belongs to this host, or when its own name states a platform and architecture
 * matching this process. Anything else falls back honestly to the configured PATH command.
 *
 * Resolution is memoised per configured value so that discovery, Doctor, readiness, model discovery
 * and the adapter that actually runs the turn all name the same file. Two answers to "which Codex"
 * is the defect this module exists to remove, not a cost worth paying for freshness.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CODEX_DEFAULT_COMMAND = "codex";

/** The identifier the OpenAI VS Code extension publishes under, whatever platform suffix follows. */
const OPENAI_EXTENSION_ID = "openai.chatgpt";

const extensionDirectoryPattern = /^openai\.chatgpt-(\d+(?:\.\d+)*)(?:-(.+))?$/u;

export type ExecutableProbe = {
  listDirectory: (directory: string) => readonly string[];
  isExecutableFile: (candidate: string) => boolean;
};

/**
 * What the extension host itself can say about where it loads extensions from. Neither field is
 * guessed: a caller outside an extension host — a script, a test — supplies neither, and resolution
 * then relies on what candidate names state about themselves.
 */
export type CodexExtensionHost = {
  /** The OpenAI extension's own directory, as `vscode.extensions.getExtension` reports it. */
  openAiExtensionPath?: string | undefined;
  /** The directory this host loads extensions from, i.e. the parent of Bachata's own directory. */
  extensionsDirectory?: string | undefined;
};

export type CodexExecutableSources = CodexExtensionHost & {
  /** Directories holding installed VS Code extensions, most preferred first. */
  extensionDirectories: readonly string[];
  probe: ExecutableProbe;
  platform: NodeJS.Platform;
  arch: string;
};

export type BundledCodexExecutable = {
  path: string;
  /** The extension version the binary shipped with, as its directory name records it. */
  extensionVersion: string;
  extensionDirectory: string;
  /** Whether this is the extension the current host loaded, rather than one found by scanning. */
  hostOwned: boolean;
};

const fileSystemProbe: ExecutableProbe = {
  listDirectory: (directory) => {
    try {
      return fs.readdirSync(directory);
    } catch {
      return [];
    }
  },
  isExecutableFile: (candidate) => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Where VS Code keeps installed extensions. Insiders and the remote server keep their own trees, and
 * a machine may hold several. They are all listed because a host that cannot name its own tree still
 * has to find something — but a candidate from a tree this host does not load is only accepted when
 * its name proves it was built for this platform and architecture.
 */
export const defaultExtensionDirectories = (homeDirectory: string = os.homedir()): string[] => [
  path.join(homeDirectory, ".vscode", "extensions"),
  path.join(homeDirectory, ".vscode-insiders", "extensions"),
  path.join(homeDirectory, ".vscode-server", "extensions"),
  path.join(homeDirectory, ".vscode-server-insiders", "extensions"),
];

// What the extension host told us about itself. Registered once, at activation, because every
// consumer of this module resolves through the same memoised answer and none of them may import
// `vscode` — this module is loaded by scripts and tests that have no extension host at all.
let registeredHost: CodexExtensionHost = {};

const defaultSources = (): CodexExecutableSources => ({
  extensionDirectories: defaultExtensionDirectories(),
  probe: fileSystemProbe,
  platform: process.platform,
  arch: process.arch,
  ...registeredHost,
});

/**
 * Newest first, comparing version segments numerically. A string comparison puts `26.903.9` after
 * `26.903.71938`, which would pick a build the reader upgraded away from.
 */
const compareVersionsDescending = (left: string, right: string): number => {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
};

// Longest spellings first: `x86_64` also contains `x86`, and `darwin-arm64` also contains `arm`, so
// a shorter token matched first would name the wrong target.
const ARCHITECTURE_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["aarch64", "arm64"],
  ["arm64", "arm64"],
  ["x86_64", "x64"],
  ["amd64", "x64"],
  ["x64", "x64"],
  ["armv7", "arm"],
  ["i686", "ia32"],
  ["ia32", "ia32"],
  ["x86", "ia32"],
  ["arm", "arm"],
];

const PLATFORM_TOKENS: ReadonlyArray<readonly [string, NodeJS.Platform]> = [
  ["darwin", "darwin"],
  ["macos", "darwin"],
  ["apple", "darwin"],
  ["osx", "darwin"],
  ["linux", "linux"],
  ["windows", "win32"],
  ["win32", "win32"],
  ["win", "win32"],
];

const declaredFrom = <T extends string>(
  name: string,
  tokens: ReadonlyArray<readonly [string, T]>,
): T | undefined => tokens.find(([token]) => name.includes(token))?.[1];

/**
 * What a directory name states about the target it was built for, and whether that contradicts this
 * process. A name that states nothing is not evidence of compatibility — it is the absence of
 * evidence, which is why `stated` is reported separately from `compatible`.
 */
const targetEvidence = (
  name: string,
  sources: CodexExecutableSources,
): { compatible: boolean; statedPlatform: boolean; statedArchitecture: boolean } => {
  const lower = name.toLowerCase();
  const platform = declaredFrom(lower, PLATFORM_TOKENS);
  const architecture = declaredFrom(lower, ARCHITECTURE_TOKENS);
  return {
    compatible:
      (platform === undefined || platform === sources.platform) &&
      (architecture === undefined || architecture === sources.arch),
    statedPlatform: platform !== undefined,
    statedArchitecture: architecture !== undefined,
  };
};

/**
 * The Codex inside one extension directory, or nothing.
 *
 * The extension is published per platform, so its `bin` holds one target and the name of that target
 * is the extension's business, not Bachata's: every child of `bin` is asked rather than a table of
 * triples being kept in step with OpenAI's builds. What Bachata does insist on is that nothing in
 * the path contradicts this process, and — for a directory this host did not load — that something
 * in the path positively states the platform and architecture it was built for.
 */
const bundledExecutableIn = (
  extensionDirectory: string,
  suffix: string | undefined,
  sources: CodexExecutableSources,
  hostOwned: boolean,
): string | undefined => {
  const executableName = sources.platform === "win32" ? "codex.exe" : "codex";
  const fromSuffix = suffix === undefined
    ? { compatible: true, statedPlatform: false, statedArchitecture: false }
    : targetEvidence(suffix, sources);
  if (!fromSuffix.compatible) return undefined;
  const binaryRoot = path.join(extensionDirectory, "bin");
  const usable = (
    candidate: string,
    fromTarget: ReturnType<typeof targetEvidence>,
  ): string | undefined => {
    if (!fromTarget.compatible) return undefined;
    const proven =
      (fromSuffix.statedPlatform || fromTarget.statedPlatform) &&
      (fromSuffix.statedArchitecture || fromTarget.statedArchitecture);
    if (!hostOwned && !proven) return undefined;
    return sources.probe.isExecutableFile(candidate) ? candidate : undefined;
  };
  const direct = usable(
    path.join(binaryRoot, executableName),
    { compatible: true, statedPlatform: false, statedArchitecture: false },
  );
  if (direct !== undefined) return direct;
  for (const entry of sources.probe.listDirectory(binaryRoot)) {
    const candidate = usable(
      path.join(binaryRoot, entry, executableName),
      targetEvidence(entry, sources),
    );
    if (candidate !== undefined) return candidate;
  }
  return undefined;
};

const executableForDirectory = (
  directory: string,
  sources: CodexExecutableSources,
  hostOwned: boolean,
): BundledCodexExecutable | undefined => {
  const match = extensionDirectoryPattern.exec(path.basename(directory));
  if (!match?.[1]) return undefined;
  const executable = bundledExecutableIn(directory, match[2], sources, hostOwned);
  if (executable === undefined) return undefined;
  return {
    path: executable,
    extensionVersion: match[1],
    extensionDirectory: directory,
    hostOwned,
  };
};

/**
 * Every Codex this host may run, most authoritative first.
 *
 * The extension the current host loaded comes first whatever its version, because that is the build
 * the reader's editor is actually running; then this host's own extensions tree; then other trees,
 * each newest first, and only where the candidate proved which target it was built for.
 */
export const bundledCodexExecutables = (
  overrides: Partial<CodexExecutableSources> = {},
): BundledCodexExecutable[] => {
  const sources: CodexExecutableSources = { ...defaultSources(), ...overrides };
  const hostExtension = sources.openAiExtensionPath === undefined
    ? undefined
    : executableForDirectory(sources.openAiExtensionPath, sources, true);
  const hostTree = sources.extensionsDirectory;
  const directories = hostTree === undefined
    ? [...sources.extensionDirectories]
    : [hostTree, ...sources.extensionDirectories.filter((directory) => directory !== hostTree)];
  const scanned = directories.map((directory) => ({
    ownTree: directory === hostTree,
    found: sources.probe
      .listDirectory(directory)
      .flatMap((entry) => {
        const candidate = executableForDirectory(path.join(directory, entry), sources, false);
        return candidate === undefined ? [] : [candidate];
      })
      .sort((left, right) =>
        compareVersionsDescending(left.extensionVersion, right.extensionVersion),
      ),
  }));
  const ordered = [
    ...(hostExtension === undefined ? [] : [hostExtension]),
    ...scanned.filter((group) => group.ownTree).flatMap((group) => group.found),
    ...scanned.filter((group) => !group.ownTree).flatMap((group) => group.found),
  ];
  const seen = new Set<string>();
  return ordered.flatMap((entry) => {
    if (seen.has(entry.path)) return [];
    seen.add(entry.path);
    return [entry];
  });
};

/**
 * Whether the reader has stated which Codex to run. Only the untouched default is replaced: any
 * other value — an absolute path, a wrapper script, a differently named CLI — is authoritative.
 */
export const isDefaultCodexCommand = (configured: string | undefined): boolean =>
  (configured ?? CODEX_DEFAULT_COMMAND).trim() === CODEX_DEFAULT_COMMAND;

const resolutionCache = new Map<string, string>();

/** Forget what was resolved, so the next question asks the file system again. */
export const resetCodexExecutableCache = (): void => {
  resolutionCache.clear();
};

/**
 * What the extension host knows about its own installation, stated once at activation.
 *
 * Registering clears the memo: a resolution taken before the host could speak was the scan's answer,
 * and the host's answer supersedes it.
 */
export const registerCodexExtensionHost = (host: CodexExtensionHost): void => {
  registeredHost = {
    ...(host.openAiExtensionPath === undefined
      ? {}
      : { openAiExtensionPath: host.openAiExtensionPath }),
    ...(host.extensionsDirectory === undefined
      ? {}
      : { extensionsDirectory: host.extensionsDirectory }),
  };
  resetCodexExecutableCache();
};

/**
 * The executable Bachata should start for a Codex participant.
 *
 * Returns the configured value unchanged whenever the reader configured one, and otherwise the Codex
 * this host may run, falling back to plain `codex` on a machine with no usable bundled build — a
 * machine where the PATH answer is the only answer there is.
 */
export const resolveCodexExecutable = (
  configured: string | undefined,
  overrides?: Partial<CodexExecutableSources>,
): string => {
  const requested = (configured ?? CODEX_DEFAULT_COMMAND).trim() || CODEX_DEFAULT_COMMAND;
  if (!isDefaultCodexCommand(requested)) return requested;
  if (overrides === undefined) {
    const cached = resolutionCache.get(requested);
    if (cached !== undefined) return cached;
  }
  const resolved = bundledCodexExecutables(overrides ?? {})[0]?.path ?? CODEX_DEFAULT_COMMAND;
  if (overrides === undefined) resolutionCache.set(requested, resolved);
  return resolved;
};

/**
 * The same resolution, expressed over a settings reader, so a caller that already holds one does not
 * have to remember the setting key or the fallback and cannot disagree about either.
 */
export const resolveCodexCommandSetting = (
  read: (key: string, fallback: string) => string,
  overrides?: Partial<CodexExecutableSources>,
): string => resolveCodexExecutable(read("codexCommand", CODEX_DEFAULT_COMMAND), overrides);

/** Whether a command names a Codex the OpenAI VS Code extension supplied, for reporting. */
export const isBundledCodexExecutable = (command: string): boolean =>
  command.includes(`${path.sep}${OPENAI_EXTENSION_ID}`) ||
  command.includes(`/${OPENAI_EXTENSION_ID}`);
