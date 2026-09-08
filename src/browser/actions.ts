import { createHash, randomUUID } from "node:crypto";

import { CapturedSegment } from "./protocol";

export type BrowserActionKind =
  | "workspace.list"
  | "workspace.read"
  | "workspace.search"
  | "workspace.write"
  | "workspace.applyPatch"
  | "workspace.delete"
  | "shell.run";

export type BrowserActionRisk = "readOnly" | "mutating" | "destructive";
export type BrowserActionOrigin = "structured" | "heuristic" | "semantic";

export type BrowserActionSource = {
  start: number;
  end: number;
  text: string;
  language?: string;
};

export type BrowserActionCandidate = {
  id: string;
  fingerprint: string;
  kind: BrowserActionKind;
  risk: BrowserActionRisk;
  origin: BrowserActionOrigin;
  confidence: "explicit" | "high" | "medium";
  source: BrowserActionSource;
  command?: string;
  path?: string;
  query?: string;
  content?: string;
  patch?: string;
  recursive?: boolean;
  expectedFiles?: Array<{ path: string; sha256: string }>;
};

export type BrowserActionExecutionResult = {
  actionId: string;
  status: "completed" | "failed" | "rejected" | "skipped";
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  affectedPaths?: string[];
  startedAt: string;
  completedAt: string;
};

const shellLanguages = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "powershell",
  "ps1",
  "cmd",
  "bat",
  "console",
  "terminal",
]);

const bachataActionLanguages = new Set(["bachata-action", "bachata_action", "bachata"]);
const diffLanguages = new Set(["diff", "patch"]);
const readOnlyExecutables = new Set([
  "pwd",
  "ls",
  "dir",
  "rg",
  "grep",
  "cat",
  "type",
  "head",
  "tail",
  "wc",
]);
const destructivePattern =
  /(?:^|\s)(?:rm\s+-[^\n]*r|rmdir|del\s+\/|erase\s+|git\s+(?:reset\s+--hard|clean\s+-|checkout\s+--)|format\s+|mkfs\b|shutdown\b|reboot\b)(?:\s|$)/i;
const mutatingPattern =
  /(?:^|\s)(?:mv|move|cp|copy|mkdir|touch|chmod|chown|git\s+(?:add|commit|checkout|switch|restore|merge|rebase|cherry-pick|revert|tag|push|pull|fetch)|npm\s+(?:install|uninstall|update)|pnpm\s+(?:add|remove|install|update)|yarn\s+(?:add|remove|install|upgrade)|bun\s+(?:add|remove|install|update)|pip\s+install|cargo\s+(?:add|install|update)|go\s+get|dotnet\s+add)(?:\s|$)/i;
const shellMetacharacterPattern = /[|&;<>`$(){}\[\]*?!~]/;
const unsafePathPattern = /(?:^|\s)(?:\.{2}(?:[\\/]|\s|$)|[A-Za-z]:[\\/]|\/(?:[^\s]|$)|~[\\/])/;
const negatedInstructionPattern =
  /(?:\bdo\s+not|\bdon't|\bnever|\bcannot|\bcan't|\bdid\s+not|\bdidn't|\bshould\s+not|\bshouldn't|\bmust\s+not|\bmustn't|\bwas\s+not\s+asked\s+to|\bwere\s+not\s+asked\s+to|\bnot\s+ask(?:ed)?\s+(?:me\s+)?to)\s*$/i;

const compact = (value: string): string => value.replace(/\r\n/g, "\n").trim();

const hashText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const normalizedActionPath = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const platformPath = process.platform === "win32" ? value.replace(/\\/g, "/") : value;
  return platformPath.replace(/^\.\//, "");
};

export const canonicalBrowserActionFingerprint = (
  action: Pick<
    BrowserActionCandidate,
    "kind" | "command" | "path" | "query" | "content" | "patch" | "recursive" | "expectedFiles"
  >,
): string =>
  hashText(
    JSON.stringify({
      kind: action.kind,
      ...(action.command === undefined ? {} : { command: compact(action.command) }),
      ...(normalizedActionPath(action.path) === undefined
        ? {}
        : { path: normalizedActionPath(action.path) }),
      ...(action.query === undefined ? {} : { query: action.query }),
      ...(action.content === undefined
        ? {}
        : { contentSha256: hashText(action.content) }),
      ...(action.patch === undefined ? {} : { patchSha256: hashText(action.patch.replace(/\r\n/g, "\n")) }),
      ...(action.recursive === undefined ? {} : { recursive: action.recursive }),
      ...(action.expectedFiles === undefined ? {} : {
        expectedFiles: action.expectedFiles.map((entry) => ({ path: normalizedActionPath(entry.path), sha256: entry.sha256.toLowerCase() })),
      }),
    }),
  );

const sourceFor = (segment: CapturedSegment): BrowserActionSource => ({
  start: segment.start,
  end: segment.end,
  text: segment.text,
  ...(segment.language ? { language: segment.language } : {}),
});

export const shellRisk = (command: string): BrowserActionRisk => {
  const normalized = compact(command);
  if (destructivePattern.test(normalized)) {
    return "destructive";
  }
  if (
    mutatingPattern.test(normalized) ||
    shellMetacharacterPattern.test(normalized) ||
    unsafePathPattern.test(normalized)
  ) {
    return "mutating";
  }
  const tokens = normalized.split(/\s+/);
  const executable = tokens[0]?.toLowerCase();
  if (!executable) {
    return "mutating";
  }
  if (executable === "git") {
    const subcommand = tokens[1]?.toLowerCase();
    return new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]).has(
      subcommand ?? "",
    )
      ? "readOnly"
      : "mutating";
  }
  if (executable === "find" || executable === "fd") {
    return normalized.includes("-exec") || normalized.includes("-delete")
      ? "mutating"
      : "readOnly";
  }
  if (executable === "sed") {
    return /(?:^|\s)-(?:[^\s]*i[^\s]*)(?:\s|$)/.test(normalized)
      ? "mutating"
      : "readOnly";
  }
  return readOnlyExecutables.has(executable) ? "readOnly" : "mutating";
};

export const patchRisk = (patch: string): BrowserActionRisk =>
  /^(?:deleted file mode\b|\+\+\+\s+\/dev\/null\b|rename to\s+\/dev\/null\b)/m.test(
    patch.replace(/\r\n/g, "\n"),
  )
    ? "destructive"
    : "mutating";

export const actionRisk = (
  kind: BrowserActionKind,
  value?: Pick<BrowserActionCandidate, "command" | "patch">,
): BrowserActionRisk => {
  if (
    kind === "workspace.list" ||
    kind === "workspace.read" ||
    kind === "workspace.search"
  ) {
    return "readOnly";
  }
  if (kind === "workspace.delete") {
    return "destructive";
  }
  if (kind === "workspace.applyPatch") {
    return patchRisk(value?.patch ?? "");
  }
  if (kind === "shell.run") {
    return shellRisk(value?.command ?? "");
  }
  return "mutating";
};

export const createBrowserActionCandidate = (
  value: Omit<BrowserActionCandidate, "id" | "fingerprint">,
): BrowserActionCandidate => ({
  id: randomUUID(),
  fingerprint: canonicalBrowserActionFingerprint(value),
  ...value,
});

const parsePairAction = (
  segment: CapturedSegment,
  expectedTurnToken?: string,
): BrowserActionCandidate | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(segment.text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (expectedTurnToken !== undefined && record.turnToken !== expectedTurnToken) {
    return undefined;
  }
  const kind = record.kind;
  if (
    typeof kind !== "string" ||
    !new Set<BrowserActionKind>([
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "workspace.write",
      "workspace.applyPatch",
      "workspace.delete",
      "shell.run",
    ]).has(kind as BrowserActionKind)
  ) {
    return undefined;
  }
  const candidate = {
    kind: kind as BrowserActionKind,
    origin: "structured" as const,
    confidence: "explicit" as const,
    source: sourceFor(segment),
    ...(typeof record.command === "string"
      ? { command: compact(record.command) }
      : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.query === "string" ? { query: record.query } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
    ...(typeof record.recursive === "boolean"
      ? { recursive: record.recursive }
      : {}),
    ...(Array.isArray(record.expectedFiles)
      ? {
          expectedFiles: record.expectedFiles
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
            .filter((entry) => typeof entry.path === "string" && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/i.test(entry.sha256))
            .map((entry) => ({ path: entry.path as string, sha256: String(entry.sha256).toLowerCase() })),
        }
      : {}),
  };
  if (
    (candidate.kind === "shell.run" && !candidate.command) ||
    (new Set([
      "workspace.list",
      "workspace.read",
      "workspace.write",
      "workspace.delete",
    ]).has(candidate.kind) &&
      !candidate.path) ||
    (candidate.kind === "workspace.search" && !candidate.query) ||
    (candidate.kind === "workspace.write" && candidate.content === undefined) ||
    (candidate.kind === "workspace.applyPatch" && !candidate.patch)
  ) {
    return undefined;
  }
  return createBrowserActionCandidate({
    ...candidate,
    risk: actionRisk(candidate.kind, candidate),
  });
};

const precedingText = (
  segments: CapturedSegment[],
  index: number,
): string => {
  const previous = segments[index - 1];
  if (!previous || previous.type !== "text") {
    return "";
  }
  return previous.text.slice(-240);
};

const shellCommandsFromBlock = (
  text: string,
  previousText: string,
): string[] => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const prompted = lines
    .map((line) => line.match(/^\s*[$>]\s+(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));
  if (prompted.length > 0) {
    return prompted;
  }
  const markerIndex = lines.findIndex((line) =>
    /^\s*(?:#|\/\/|rem\s+)\s*Bachata\s*:\s*run\s*$/i.test(line),
  );
  if (markerIndex >= 0) {
    const command = compact(lines.slice(markerIndex + 1).join("\n"));
    return command ? [command] : [];
  }
  if (
    /(?:^|\n)\s*(?:run|execute|command|terminal|shell)(?:\s+this)?\s*:?\s*$/i.test(
      previousText,
    )
  ) {
    const command = compact(text);
    return command ? [command] : [];
  }
  return [];
};

const implicitActions = (
  segments: CapturedSegment[],
): BrowserActionCandidate[] => {
  const candidates: BrowserActionCandidate[] = [];
  segments.forEach((segment, index) => {
    if (segment.type !== "codeBlock") {
      return;
    }
    const language = segment.language?.trim().toLowerCase() ?? "";
    const previous = precedingText(segments, index);
    if (shellLanguages.has(language)) {
      shellCommandsFromBlock(segment.text, previous).forEach((command) => {
        candidates.push(
          createBrowserActionCandidate({
            kind: "shell.run",
            risk: shellRisk(command),
            origin: "heuristic",
            confidence: "high",
            source: sourceFor(segment),
            command,
          }),
        );
      });
      return;
    }
    if (
      diffLanguages.has(language) &&
      /(?:apply|use)\s+(?:this\s+)?(?:diff|patch)\s*:?\s*$/i.test(previous)
    ) {
      const patch = segment.text.replace(/\r\n/g, "\n");
      if (!patch.trim()) {
        return;
      }
      candidates.push(
        createBrowserActionCandidate({
          kind: "workspace.applyPatch",
          risk: patchRisk(patch),
          origin: "heuristic",
          confidence: "high",
          source: sourceFor(segment),
          patch,
        }),
      );
    }
  });
  return candidates;
};

const inlineShellActions = (
  text: string,
  segments: CapturedSegment[],
): BrowserActionCandidate[] => {
  const candidates: BrowserActionCandidate[] = [];
  const pattern = /\b(?:run|execute|use the command)\s+`([^`\r\n]+)`/gi;
  for (const match of text.matchAll(pattern)) {
    const command = compact(match[1] ?? "");
    if (!command || match.index === undefined) {
      continue;
    }
    const start = match.index + match[0].indexOf("`") + 1;
    const end = start + command.length;
    const sourceSegment = segments.find(
      (segment) => segment.start <= start && segment.end >= end,
    );
    candidates.push(
      createBrowserActionCandidate({
        kind: "shell.run",
        risk: shellRisk(command),
        origin: "heuristic",
        confidence: "high",
        source: {
          start,
          end,
          text: command,
          ...(sourceSegment?.language
            ? { language: sourceSegment.language }
            : {}),
        },
        command,
      }),
    );
  }
  return candidates;
};

const instructionIsNegated = (text: string, index: number): boolean => {
  const sentenceStart = Math.max(
    text.lastIndexOf("\n", index - 1),
    text.lastIndexOf(".", index - 1),
    text.lastIndexOf("!", index - 1),
    text.lastIndexOf("?", index - 1),
  );
  return negatedInstructionPattern.test(text.slice(sentenceStart + 1, index));
};

const naturalWorkspaceActions = (text: string): BrowserActionCandidate[] => {
  const candidates: BrowserActionCandidate[] = [];
  const add = (
    match: RegExpMatchArray,
    value: Omit<
      BrowserActionCandidate,
      "id" | "fingerprint" | "source" | "confidence" | "risk" | "origin"
    >,
  ): void => {
    if (match.index === undefined || instructionIsNegated(text, match.index)) {
      return;
    }
    const sourceText = match[0];
    candidates.push(
      createBrowserActionCandidate({
        ...value,
        risk: actionRisk(value.kind, value),
        origin: "heuristic",
        confidence: "high",
        source: {
          start: match.index,
          end: match.index + sourceText.length,
          text: sourceText,
        },
      }),
    );
  };

  for (const match of text.matchAll(
    /\b(?:read|open|show)(?:\s+the)?\s+file\s+`([^`\r\n]+)`/gi,
  )) {
    const filePath = match[1];
    if (filePath) {
      add(match, { kind: "workspace.read", path: filePath });
    }
  }

  for (const match of text.matchAll(
    /\b(?:list|show)(?:\s+the)?\s+files(?:\s+(?:in|under))?\s+`([^`\r\n]+)`/gi,
  )) {
    const directory = match[1];
    if (directory) {
      add(match, { kind: "workspace.list", path: directory });
    }
  }

  for (const match of text.matchAll(
    /\bsearch(?:\s+the)?\s+(?:workspace|repository)\s+for\s+`([^`\r\n]+)`/gi,
  )) {
    const query = match[1];
    if (query) {
      add(match, { kind: "workspace.search", query });
    }
  }

  for (const match of text.matchAll(
    /\bsearch\s+`([^`\r\n]+)`\s+for\s+`([^`\r\n]+)`/gi,
  )) {
    const searchPath = match[1];
    const query = match[2];
    if (searchPath && query) {
      add(match, { kind: "workspace.search", path: searchPath, query });
    }
  }

  return candidates;
};

const originPriority = (origin: BrowserActionOrigin): number =>
  origin === "structured" ? 3 : origin === "heuristic" ? 2 : 1;

export const deduplicateBrowserActions = (
  candidates: BrowserActionCandidate[],
): BrowserActionCandidate[] => {
  const unique = new Map<string, BrowserActionCandidate>();
  candidates.forEach((candidate) => {
    const existing = unique.get(candidate.fingerprint);
    if (!existing || originPriority(candidate.origin) > originPriority(existing.origin)) {
      unique.set(candidate.fingerprint, candidate);
      return;
    }
    if (
      existing.origin === candidate.origin &&
      candidate.source.start < existing.source.start
    ) {
      unique.set(candidate.fingerprint, candidate);
    }
  });
  return Array.from(unique.values()).sort(
    (left, right) => left.source.start - right.source.start,
  );
};

export const extractBrowserActions = (
  text: string,
  segments: CapturedSegment[],
  expectedStructuredTurnToken?: string,
): BrowserActionCandidate[] => {
  const explicit = segments
    .filter(
      (segment) =>
        segment.type === "codeBlock" &&
        bachataActionLanguages.has(segment.language?.trim().toLowerCase() ?? ""),
    )
    .map((segment) => parsePairAction(segment, expectedStructuredTurnToken))
    .filter((candidate): candidate is BrowserActionCandidate => Boolean(candidate));
  return deduplicateBrowserActions([
    ...explicit,
    ...implicitActions(segments),
    ...inlineShellActions(text, segments),
    ...naturalWorkspaceActions(text),
  ]);
};

export const describeBrowserAction = (
  action: BrowserActionCandidate,
): string => {
  if (action.kind === "shell.run") {
    return action.command ?? "Run shell command";
  }
  if (action.kind === "workspace.search") {
    return `Search${action.path ? ` ${action.path}` : " workspace"} for ${action.query ?? ""}`;
  }
  if (action.kind === "workspace.applyPatch") {
    return "Apply workspace patch";
  }
  if (action.kind === "workspace.write") {
    return `Write ${action.path ?? "workspace file"}`;
  }
  if (action.kind === "workspace.delete") {
    return `Delete ${action.path ?? "workspace path"}`;
  }
  if (action.kind === "workspace.read") {
    return `Read ${action.path ?? "workspace file"}`;
  }
  return `List ${action.path ?? "workspace"}`;
};
