import { isBrowserSourcePath } from "../browser/sourceTransferPolicy";
import type { RunResultCenter } from "./projectResult";
import { boundedResultInput } from "./boundedResultInput";
import { assertPreparedDraftSize, RESULT_TEXT_LIMITS } from "./textLimits";
import { parseResultStructuredText, readableResultFields, readableResultMarkdown, scrubOpaqueResultTokens } from "./readableResult";

const decodedReference = (value: string): string => {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = decoded.replace(/(?:%[a-f\d]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
      .replace(/\\u([a-f\d]{4})/giu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
      .replace(/\\\//gu, "/")
      .replace(/&#(?:x([a-f\d]+)|(\d+));/giu, (_, hex: string | undefined, decimal: string | undefined) => {
        const code = Number.parseInt(hex ?? decimal ?? "0", hex === undefined ? 10 : 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : "";
      });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replace(/\\([ .()[\]`])/gu, "$1");
};

const excludedReference = (value: string, explicit = false): boolean => {
  let reference = decodedReference(value).trim().replace(/^[`'"(<[]+|[`'"\])>,;.]+$/gu, "");
  if (/^file:/iu.test(reference)) return true;
  if (/^https?:\/\//iu.test(reference)) {
    try {
      reference = decodedReference(new URL(reference).pathname).replace(/^\/+/, "");
    } catch {
      return true;
    }
  }
  reference = reference.replace(/[?#].*$/u, "").replace(/:\d+(?:(?:[-–:]|\.\.)\d+)*$/u, "");
  if (!reference || (!explicit && !/[\\/]|\.[a-z\d_-]+$/iu.test(reference))) return false;
  if (/%[a-f\d]{2}/iu.test(reference)) return true;
  return !isBrowserSourcePath(reference);
};

const containsExcludedReference = (text: string, explicit = false): boolean => {
  const decoded = decodedReference(text);
  if (explicit && excludedReference(decoded, true)) return true;
  for (const match of decoded.matchAll(/\b(?:directory|folder|tree|file|contents?\s+of|inside|under)\s+[`'"]?([^\s`'"<>()[\]{},;:]+)/giu)) {
    if (excludedReference(match[1] ?? "", true)) return true;
  }
  for (const match of decoded.matchAll(/`([^`\r\n]+)`|\]\(\s*<?([^\r\n)>]+)>?\)|\[[^\]\r\n]+\]:\s*<?([^\r\n>]+)>?|["']([^"'\r\n]+)["']/gu)) {
    const candidate = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (excludedReference(candidate, match[2] !== undefined || match[3] !== undefined)) return true;
  }
  return (decoded.match(/[^\s`'"<>()[\]{},;=]+/gu) ?? []).some((candidate) => excludedReference(candidate));
};

const SOURCE_OMISSION_NOTICE = "Some review material was withheld by the source-transfer policy. Inspect permitted current source and reconfirm findings and verification before editing; omitted material is not evidence of acceptance.";

export const implementationHandoffMarkdown = (source: RunResultCenter, maximumUnits: number = RESULT_TEXT_LIMITS.handoffMarkdownUnits): string => {
  const bounded = boundedResultInput(source);
  const result = bounded.result;
  let omitted = false;
  let limited = bounded.omitted;
  let visited = 0;
  let entryStart = 0;
  let textUnits = 0;
  const parsedStrings = new Map<string, ReturnType<typeof parseResultStructuredText>>();
  const inspectedObjects = new WeakMap<object, boolean>();
  const inspectedStrings = new Map<string, boolean>();
  const visit = (depth: number): boolean => {
    if (depth >= RESULT_TEXT_LIMITS.maximumDepth
      || visited >= RESULT_TEXT_LIMITS.maximumVisitedEntries
      || visited - entryStart >= Math.floor(RESULT_TEXT_LIMITS.maximumVisitedEntries / 8)) {
      limited = true;
      return false;
    }
    visited += 1;
    return true;
  };
  const parse = (value: string): ReturnType<typeof parseResultStructuredText> | undefined => {
    const cached = parsedStrings.get(value);
    if (cached !== undefined) return cached;
    if (value.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits || textUnits + value.length > RESULT_TEXT_LIMITS.maximumInputTextUnits) {
      limited = true;
      return undefined;
    }
    textUnits += value.length;
    const parsed = parseResultStructuredText(value);
    parsedStrings.set(value, parsed);
    return parsed;
  };
  const omit = (): undefined => {
    omitted = true;
    return undefined;
  };
  const ownsExcludedSource = (value: unknown, key = "", depth = 0): boolean => {
    if (depth === 0) entryStart = visited;
    if (!visit(depth)) return true;
    if (typeof value === "string") {
      const explicit = ["file", "path", "relativePath", "location"].includes(key);
      const cacheKey = `${String(explicit)}:${value}`;
      const cached = inspectedStrings.get(cacheKey);
      if (cached !== undefined) return cached;
      const parsed = parse(value);
      const excluded = parsed === undefined
        || (parsed.structured && ownsExcludedSource(parsed.value, key, depth + 1))
        || containsExcludedReference(value, explicit);
      inspectedStrings.set(cacheKey, excluded);
      return excluded;
    }
    if (value === null || typeof value !== "object") return false;
    const cached = inspectedObjects.get(value);
    if (cached !== undefined) return cached;
    let excluded = false;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (ownsExcludedSource(item, key, depth + 1)) {
          excluded = true;
          break;
        }
      }
    } else {
      for (const field of Object.keys(readableResultFields).concat("path", "relativePath")) {
        if (Object.hasOwn(value, field) && ownsExcludedSource((value as Record<string, unknown>)[field], field, depth + 1)) {
          excluded = true;
          break;
        }
      }
    }
    inspectedObjects.set(value, excluded);
    return excluded;
  };
  const project = <T>(value: T, depth = 0): T | undefined => {
    if (depth === 0) entryStart = visited;
    if (!visit(depth)) return omit();
    if (typeof value === "string") {
      const parsed = parse(value);
      if (parsed === undefined) return omit();
      if (parsed.structured) {
        if (ownsExcludedSource(parsed.value)) return omit();
        const projected = project(parsed.value, depth + 1);
        return projected === undefined ? omit() : JSON.stringify(projected) as T;
      }
      return containsExcludedReference(value) ? omit() : value;
    }
    if (Array.isArray(value)) {
      const projected: unknown[] = [];
      for (const item of value) {
        const next = project(item, depth + 1);
        if (next !== undefined) projected.push(next);
        if (visited >= RESULT_TEXT_LIMITS.maximumVisitedEntries) {
          limited = true;
          break;
        }
      }
      return projected as T;
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (ownsExcludedSource(record)) return omit();
      const projected: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        const next = project(record[key], depth + 1);
        if (next !== undefined) projected[key] = next;
        if (visited >= RESULT_TEXT_LIMITS.maximumVisitedEntries) return omit();
      }
      return projected as T;
    }
    return value;
  };
  const failure = result.finalAssessment.failure ?? result.failure;
  const projectedFailure = failure === undefined ? undefined : {
    ...failure,
    error: project(failure.error) ?? "Failure details were withheld; inspect the current source before proceeding.",
  };
  const decision = result.finalDecision;
  const summary = project(result.finalAssessment.summary) ?? "Assessment details were withheld; confirmation is still required.";
  const finalRuling = result.finalRuling === undefined ? undefined : project(result.finalRuling) ?? "Ruling details were withheld; no additional finding is confirmed.";
  const candidate = decision?.candidate === undefined ? undefined
    : (ownsExcludedSource(decision.candidate) ? omit() : project(decision.candidate)) ?? "The selected ruling material was withheld; reconfirm it against the current source.";
  const unresolvedRisks = project(result.unresolvedRisks) ?? [];
  const decisionRisks = project(decision?.unresolvedRisks) ?? [];
  const evidenceGaps = project(result.evidenceGaps) ?? [];
  const projected: RunResultCenter = {
    ...result,
    finalAssessment: {
      ...result.finalAssessment,
      summary,
      ...(projectedFailure === undefined ? {} : { failure: projectedFailure }),
    },
    ...(projectedFailure === undefined ? {} : { failure: projectedFailure }),
    ...(finalRuling === undefined ? {} : { finalRuling }),
    ...(decision === undefined ? {} : {
      finalDecision: {
        ...decision,
        ...(candidate === undefined ? {} : { candidate }),
        participants: [],
        objections: [],
        unresolvedRisks: decisionRisks,
        ...(decision.humanResolution === undefined ? {} : {
          humanResolution: { ...decision.humanResolution, rationale: project(decision.humanResolution.rationale) ?? "Rationale details were withheld." },
        }),
      },
    }),
    findings: result.findings.flatMap((finding) => {
      if (ownsExcludedSource(finding)) {
        omit();
        return [];
      }
      return [{
        ...finding,
        subject: project(finding.subject) ?? "Finding details withheld",
        message: project(finding.message) ?? "Confirm this finding against the current source before editing.",
        evidence: project(finding.evidence) ?? [],
        challenges: project(finding.challenges) ?? [],
      }];
    }),
    changedFiles: result.changedFiles.filter((file) => {
      if (!containsExcludedReference(file, true)) return true;
      omit();
      return false;
    }),
    checks: project(result.checks) ?? [],
    unresolvedRisks,
    evidenceGaps,
  };
  if (projected.finalDecision !== undefined) {
    projected.finalDecision.objections = project(decision?.objections) ?? [];
    projected.finalDecision.participants = project(decision?.participants) ?? [];
  }
  const visible = scrubOpaqueResultTokens(readableResultMarkdown(projected, {
    maximumUnits: Math.min(maximumUnits, RESULT_TEXT_LIMITS.handoffMarkdownUnits) - SOURCE_OMISSION_NOTICE.length - 2,
    omitted: limited,
    opaqueSource: source,
  }));
  return [
    visible,
    ...(omitted ? [SOURCE_OMISSION_NOTICE] : []),
  ].join("\n\n");
};

export const implementationDraftFromResult = (result: RunResultCenter): string => {
  const instructions = [
    result.status === "completed"
      ? "Implement the findings from this completed run only after confirming them against the current source. A completed execution does not mean its assessment or findings were accepted."
      : "Review the material from this stopped run and implement only findings confirmed against the current source. An interrupted or failed run does not establish that its findings were accepted.",
    "Re-read the current source, preserve unrelated changes, and verify every change. Unresolved findings require confirmation before edits. Findings, risks, and evidence gaps below are review input, not confirmed defects or permission to implement rejected findings. Preserve the recorded dispositions and report anything that remains unverified.",
  ].join("\n\n");
  const handoff = implementationHandoffMarkdown(result, RESULT_TEXT_LIMITS.preparedDraftUnits - instructions.length - 2);
  // Match textarea parsing before the draft enters host state, so saving it from
  // the webview cannot change its line endings or embedded null characters.
  const draft = `${instructions}\n\n${handoff}`.replace(/\r\n?/gu, "\n").replace(/\0/gu, "\uFFFD");
  assertPreparedDraftSize(draft);
  return draft;
};
