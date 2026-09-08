import * as path from "node:path";
import { readFile } from "node:fs/promises";

import { walkBundle } from "../longitudinal/bundleSchema";
import type { BundleSpec } from "../longitudinal/bundleSchema";

export const EXPORT_POLICY_PATH = ".bachata/export-policy.json";
export const EXCLUDED_PATH_PLACEHOLDER = "[EXCLUDED BY EXPORT POLICY]";

export type ExportPolicy = {
  version: 1;
  redactLiterals: string[];
  excludePathPrefixes: string[];
};

export type ExportPolicyLoad = {
  present: boolean;
  policy?: ExportPolicy;
  errors: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseExportPolicy = (value: unknown): { policy?: ExportPolicy; errors: string[] } => {
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: ["The export policy must be a JSON object"] };
  Object.keys(value)
    .filter((key) => !["version", "redactLiterals", "excludePathPrefixes"].includes(key))
    .forEach((key) => errors.push(`The export policy has an unknown key: ${key}`));
  if (value.version !== 1) errors.push('The export policy must declare "version": 1');
  const literals = value.redactLiterals ?? [];
  const prefixes = value.excludePathPrefixes ?? [];
  if (!Array.isArray(literals) || literals.some((entry) => typeof entry !== "string" || entry.length < 3)) {
    errors.push("redactLiterals must be strings of at least 3 characters");
  } else if (literals.length > 256) {
    errors.push("redactLiterals declares more than 256 entries");
  }
  if (!Array.isArray(prefixes) || prefixes.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    errors.push("excludePathPrefixes must be non-empty strings");
  } else if (prefixes.length > 256) {
    errors.push("excludePathPrefixes declares more than 256 entries");
  }
  return errors.length > 0
    ? { errors }
    : {
        policy: {
          version: 1,
          redactLiterals: literals as string[],
          excludePathPrefixes: (prefixes as string[]).map((entry) => entry.replaceAll("\\", "/")),
        },
        errors,
      };
};

export const loadExportPolicy = async (repositoryRoot: string): Promise<ExportPolicyLoad> => {
  let source: string;
  try {
    source = await readFile(path.join(repositoryRoot, ...EXPORT_POLICY_PATH.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, errors: [] };
    return {
      present: true,
      errors: [`${EXPORT_POLICY_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return {
      present: true,
      errors: [`${EXPORT_POLICY_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = parseExportPolicy(value);
  return parsed.policy
    ? { present: true, policy: parsed.policy, errors: [] }
    : { present: true, errors: parsed.errors };
};

export const applyExportPolicy = (
  content: string,
  policy: ExportPolicy | undefined,
): { content: string; applied: Array<{ literal: string; occurrences: number }> } => {
  if (!policy || policy.redactLiterals.length === 0) return { content, applied: [] };
  const applied: Array<{ literal: string; occurrences: number }> = [];
  const redacted = policy.redactLiterals.reduce((result, literal) => {
    const parts = result.split(literal);
    if (parts.length > 1) applied.push({ literal, occurrences: parts.length - 1 });
    return parts.join("[REDACTED]");
  }, content);
  return { content: redacted, applied };
};

export const normalizeComparablePath = (value: string): string => {
  const unified = value.replaceAll("\\", "/");
  const absolute = unified.startsWith("/");
  const segments: string[] = [];
  unified.split("/").forEach((segment) => {
    if (segment.length === 0 || segment === ".") return;
    if (segment === "..") {
      const last = segments.at(-1);
      if (last !== undefined && last !== "..") segments.pop();
      else if (!absolute) segments.push("..");
      return;
    }
    segments.push(segment);
  });
  return `${absolute ? "/" : ""}${segments.join("/")}`;
};

const matchesExcludedPrefix = (candidate: string, prefix: string): boolean => {
  const normalizedPrefix = normalizeComparablePath(prefix);
  if (normalizedPrefix.length === 0 || normalizedPrefix === "/") return false;
  const normalized = normalizeComparablePath(candidate);
  const hit = (value: string): boolean =>
    value === normalizedPrefix || value.startsWith(`${normalizedPrefix}/`);
  if (hit(normalized)) return true;
  if (normalizedPrefix.startsWith("/")) return false;
  const segments = normalized.replace(/^\//u, "").split("/");
  return segments.some((_, index) => index > 0 && hit(segments.slice(index).join("/")));
};

export const excludedByPolicy = (
  paths: string[],
  policy: ExportPolicy | undefined,
): string[] => {
  if (!policy || policy.excludePathPrefixes.length === 0) return [];
  return paths.filter((candidate) =>
    policy.excludePathPrefixes.some((prefix) => matchesExcludedPrefix(candidate, prefix)),
  );
};

export const exportRedactionRules = (
  policy: ExportPolicy | undefined,
  policyErrors: string[],
): string[] => [
  "Sensitive JSON keys (authorization, api key, token, secret, password, cookie, credentials) are replaced with [REDACTED].",
  "Assignment-shaped secrets in free text, command lines, environment values, and URLs are replaced with [REDACTED].",
  "Provider conversation URL paths, queries, and fragments are removed; only the origin remains.",
  "Provider session identifiers, conversation identities, and document tokens are removed.",
  ...(policy && policy.redactLiterals.length > 0
    ? [`${String(policy.redactLiterals.length)} repository-owned literal patterns from ${EXPORT_POLICY_PATH}.`]
    : []),
  ...(policy && policy.excludePathPrefixes.length > 0
    ? [`${String(policy.excludePathPrefixes.length)} repository-owned excluded path prefixes from ${EXPORT_POLICY_PATH}.`]
    : []),
  ...(policyErrors.length > 0
    ? [`${EXPORT_POLICY_PATH} was ignored because it failed validation: ${policyErrors.join("; ")}`]
    : []),
];

export const EXPORT_REVIEW_WARNING =
  "Redaction is heuristic. It cannot guarantee that every secret or sensitive value was removed. Read the preview before sharing this file.";

const pathBearingKeys = new Set([
  "path", "file", "filePath", "relativePath", "uri", "fsPath", "target", "changedFile",
]);

const isExcludedPath = (value: string, policy: ExportPolicy): boolean =>
  excludedByPolicy([value], policy).length > 0;

const PATH_BOUNDARY = /[\s"'`<>|*?()[\]{},;=:]/u;

const PATH_CONTINUATION = /\.[\p{L}\p{N}]{1,16}$/u;

const SEGMENT_CHARACTER = /[\p{L}\p{N}_.-]/u;

const isBoundary = (value: string | undefined): boolean =>
  value === undefined || PATH_BOUNDARY.test(value);

const extendsSegment = (value: string | undefined): boolean =>
  value !== undefined && SEGMENT_CHARACTER.test(value);

const isSeparator = (value: string | undefined): boolean =>
  value === "/" || value === "\\";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

type PathRun = { start: number; end: number; text: string };

type PrefixMatcher = { pattern: RegExp; absolute: boolean };

const prefixMatcher = (prefix: string): PrefixMatcher | undefined => {
  const normalized = normalizeComparablePath(prefix);
  if (normalized.length === 0 || normalized === "/") return undefined;
  const absolute = normalized.startsWith("/");
  const segments = normalized.replace(/^\//u, "").split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  const joined = segments.map(escapeRegExp).join("[/\\\\]+(?:\\.[/\\\\]+)*");
  const lead = absolute ? "[/\\\\]" : "(?:\\.{1,2}[/\\\\]+)*";
  return { pattern: new RegExp(`${lead}${joined}`, "gu"), absolute };
};

const continuesPath = (text: string): boolean =>
  text.includes("/") || text.includes("\\") || PATH_CONTINUATION.test(text);

const extendBackward = (value: string, start: number): number => {
  let index = start;
  while (index > 0 && !isBoundary(value[index - 1])) index -= 1;
  return index;
};

const runEnd = (value: string, from: number): number => {
  let index = from;
  while (index < value.length && !isBoundary(value[index])) index += 1;
  return index;
};

const extendForward = (value: string, end: number): number => {
  let index = runEnd(value, end);
  for (;;) {
    if (value[index] !== " ") return index;
    const nextEnd = runEnd(value, index + 1);
    if (nextEnd === index + 1) return index;
    if (!continuesPath(value.slice(index + 1, nextEnd))) return index;
    index = nextEnd;
  }
};

const mergeRanges = (
  value: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): PathRun[] => {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  sorted.forEach((range) => {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      return;
    }
    merged.push({ ...range });
  });
  return merged.map((range) => ({ ...range, text: value.slice(range.start, range.end) }));
};

export const excludedPathRuns = (
  value: string,
  policy: ExportPolicy | undefined,
): PathRun[] => {
  if (!policy || policy.excludePathPrefixes.length === 0) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  policy.excludePathPrefixes.forEach((prefix) => {
    const matcher = prefixMatcher(prefix);
    if (matcher === undefined) return;
    matcher.pattern.lastIndex = 0;
    let match = matcher.pattern.exec(value);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (match[0].length === 0) {
        matcher.pattern.lastIndex += 1;
        match = matcher.pattern.exec(value);
        continue;
      }
      const before = start === 0 ? undefined : value[start - 1];
      const after = end >= value.length ? undefined : value[end];
      const beforeAccepted = matcher.absolute
        ? !extendsSegment(before) && !isSeparator(before)
        : !extendsSegment(before);
      const afterAccepted = !extendsSegment(after);
      if (beforeAccepted && afterAccepted) {
        ranges.push({ start: extendBackward(value, start), end: extendForward(value, end) });
      }
      match = matcher.pattern.exec(value);
    }
  });
  return mergeRanges(value, ranges);
};

export const excludedPathTokensIn = (
  value: string,
  policy: ExportPolicy | undefined,
): string[] => Array.from(new Set(excludedPathRuns(value, policy).map((run) => run.text)));

export const maskExcludedPaths = (
  value: string,
  policy: ExportPolicy | undefined,
  record: (path: string) => void = () => undefined,
): string => {
  const runs = excludedPathRuns(value, policy);
  if (runs.length === 0) return value;
  let result = "";
  let cursor = 0;
  runs.forEach((run) => {
    record(run.text);
    result += value.slice(cursor, run.start) + EXCLUDED_PATH_PLACEHOLDER;
    cursor = run.end;
  });
  return result + value.slice(cursor);
};

export type DeepPolicyResult<T> = {
  value: T;
  applied: Array<{ literal: string; occurrences: number }>;
  unclassified: string[];
};

export const applyExportPolicyToSchema = <T>(
  input: T,
  spec: BundleSpec,
  policy: ExportPolicy | undefined,
  record: (path: string) => void = () => undefined,
): DeepPolicyResult<T> => {
  const counts = new Map<string, number>();
  const unclassified: string[] = [];
  const value = walkBundle(input, spec, {
    onUnknownKey: (at) => {
      if (!unclassified.includes(at)) unclassified.push(at);
    },
    onString: (item, role) => {
      if (role === "structural") return item;
      const masked = maskExcludedPaths(item, policy, record);
      const redacted = applyExportPolicy(masked, policy);
      redacted.applied.forEach((entry) => {
        counts.set(entry.literal, (counts.get(entry.literal) ?? 0) + entry.occurrences);
      });
      return redacted.content;
    },
  }) as T;
  return {
    value,
    applied: [...counts.entries()].map(([literal, occurrences]) => ({ literal, occurrences })),
    unclassified,
  };
};

export type BundleExclusionResult<T> = { value: T; excluded: string[] };

export const excludeBundlePaths = <T>(
  input: T,
  policy: ExportPolicy | undefined,
): BundleExclusionResult<T> => {
  if (!policy || policy.excludePathPrefixes.length === 0) return { value: input, excluded: [] };
  const excluded: string[] = [];
  const record = (value: string): void => {
    if (!excluded.includes(value)) excluded.push(value);
  };
  const dropsRecord = (value: Record<string, unknown>): boolean =>
    Object.entries(value).some(([key, item]) =>
      pathBearingKeys.has(key) && typeof item === "string" && isExcludedPath(item, policy),
    );
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (isExcludedPath(value, policy)) {
        record(value);
        return EXCLUDED_PATH_PLACEHOLDER;
      }
      return maskExcludedPaths(value, policy, record);
    }
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        if (typeof item === "string") {
          if (!isExcludedPath(item, policy)) return [maskExcludedPaths(item, policy, record)];
          record(item);
          return [];
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const entry = item as Record<string, unknown>;
          if (dropsRecord(entry)) {
            Object.entries(entry)
              .filter(([key, candidate]) => pathBearingKeys.has(key) && typeof candidate === "string")
              .forEach(([, candidate]) => {
                if (isExcludedPath(candidate as string, policy)) record(candidate as string);
              });
            return [];
          }
        }
        return [walk(item)];
      });
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item)]),
      );
    }
    return value;
  };
  return { value: walk(input) as T, excluded };
};
