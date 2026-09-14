import type { RunResultCenter } from "./projectResult";
import { RESULT_TEXT_LIMITS } from "./textLimits";

export const RESULT_OMISSION_NOTICE = "Some result material was omitted because the result text limits were reached. Review the complete recorded result before editing; omitted material is not evidence of acceptance or verification.";

export const boundedResultKeys = [
  "summary", "title", "subject", "message", "text", "statement", "conclusion", "recommendation",
  "reason", "rationale", "description", "details", "findings", "evidence", "challenges", "location",
  "file", "path", "relativePath", "startLine", "endLine", "severity", "disposition", "accepted",
  "objections", "unresolvedRisks", "risks", "tradeOffs", "validationErrors", "verification", "checks",
  "command", "status", "stale", "evidenceGaps", "changedFiles", "candidate", "assessment",
  "finalAssessment", "finalDecision", "finalRuling", "warning", "error", "outcome", "method", "failure", "action",
  "humanResolution", "participants", "expectations", "id", "agentId", "stepId", "participantIds",
  "executionRef", "reference", "outputReference", "candidateHash", "candidateDigest", "candidateTree",
  "candidateFingerprint", "fileDigest", "digest", "hash", "fingerprint", "resultVersion", "sessionId",
  "session", "providerSession", "sessionData", "provenance", "metadata", "value", "ruledBy", "resolvedBy",
  "rulingBy", "retainedWorktree", "retainedRunId", "selectedParticipant", "resolvedAt", "source",
  "decisionStatus", "providers", "producedBy", "name", "adapter", "model", "provider",
] as const;

type Budget = { visited: number; text: number; omitted: boolean };
type EntryBudget = { text: number; visited: number };
const omittedValue = Symbol("omitted result entry");

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const copyEntry = (value: unknown, budget: Budget, entry: EntryBudget, depth = 0): unknown => {
  if (value === undefined || value === null) return value;
  if (budget.visited >= RESULT_TEXT_LIMITS.maximumVisitedEntries
    || entry.visited >= Math.floor(RESULT_TEXT_LIMITS.maximumVisitedEntries / 8)
    || depth >= RESULT_TEXT_LIMITS.maximumDepth) {
    budget.omitted = true;
    return omittedValue;
  }
  budget.visited += 1;
  entry.visited += 1;
  if (typeof value === "string") {
    if (value.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits
      || entry.text + value.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits
      || budget.text + value.length > RESULT_TEXT_LIMITS.maximumInputTextUnits) {
      budget.omitted = true;
      return omittedValue;
    }
    entry.text += value.length;
    budget.text += value.length;
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    if (value.length > RESULT_TEXT_LIMITS.maximumSectionEntries) {
      budget.omitted = true;
      return omittedValue;
    }
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = copyEntry(value[index], budget, entry, depth + 1);
      if (item === omittedValue) return omittedValue;
      copy.push(item);
    }
    return copy;
  }
  const record = recordOf(value);
  if (!record) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of boundedResultKeys) {
    if (!Object.hasOwn(record, key)) continue;
    const item = copyEntry(record[key], budget, entry, depth + 1);
    if (item === omittedValue) return omittedValue;
    if (item !== undefined) copy[key] = item;
  }
  return copy;
};

export const boundedResultValue = (value: unknown): { value: unknown; omitted: boolean } => {
  const budget: Budget = { visited: 0, text: 0, omitted: false };
  const copy = copyEntry(value, budget, { text: 0, visited: 0 });
  return { value: copy === omittedValue ? undefined : copy, omitted: budget.omitted };
};

export const boundedResultInput = (source: RunResultCenter): { result: RunResultCenter; omitted: boolean } => {
  const budget: Budget = { visited: 0, text: 0, omitted: false };
  const single = <T>(value: T): T | undefined => {
    const copy = copyEntry(value, budget, { text: 0, visited: 0 });
    return copy === omittedValue ? undefined : copy as T;
  };
  const section = <T>(values: readonly T[] | undefined): T[] => {
    if (!Array.isArray(values)) return [];
    const copy: T[] = [];
    const sectionStart = budget.text;
    const visitedStart = budget.visited;
    const sectionLimit = Math.floor(RESULT_TEXT_LIMITS.maximumInputTextUnits / 8);
    const count = Math.min(values.length, RESULT_TEXT_LIMITS.maximumSectionEntries);
    if (values.length > count) budget.omitted = true;
    for (let index = 0; index < count; index += 1) {
      if (budget.visited >= RESULT_TEXT_LIMITS.maximumVisitedEntries
        || budget.visited - visitedStart >= Math.floor(RESULT_TEXT_LIMITS.maximumVisitedEntries / 8)
        || budget.text - sectionStart >= sectionLimit) {
        budget.omitted = true;
        break;
      }
      const item = single(values[index]);
      if (item !== undefined) copy.push(item);
    }
    return copy;
  };
  const originalAssessment = source.finalAssessment;
  const finalAssessment: RunResultCenter["finalAssessment"] = {
    outcome: originalAssessment?.outcome ?? "inconclusive",
    method: originalAssessment?.method ?? "none",
    summary: single(originalAssessment?.summary) ?? "Assessment details were omitted; confirmation is still required.",
    producedBy: [],
  };
  const originalFailure = originalAssessment?.failure ?? source.failure;
  const failure = originalFailure === undefined ? undefined : {
    error: single(originalFailure.error) ?? "Failure details were omitted; inspect the recorded failure before proceeding.",
  };
  if (failure !== undefined) finalAssessment.failure = failure;
  const originalDecision = source.finalDecision;
  const decision: RunResultCenter["finalDecision"] = originalDecision === undefined ? undefined : {
    stepId: single(originalDecision.stepId) ?? "",
    status: originalDecision.status,
    participants: [],
    objections: [],
    unresolvedRisks: [],
    ...(originalDecision.candidate === undefined ? {} : {
      candidate: single(originalDecision.candidate) ?? "The selected ruling material was omitted; reconfirm it against the current source.",
    }),
    ...(originalDecision.humanResolution === undefined ? {} : {
      humanResolution: {
        action: originalDecision.humanResolution.action,
        rationale: single(originalDecision.humanResolution.rationale) ?? "Rationale details were omitted; confirmation is still required.",
        resolvedAt: "",
      },
    }),
  };
  const finalRuling = source.finalRuling === undefined ? undefined
    : single(source.finalRuling) ?? "Ruling details were omitted; no additional finding is confirmed.";
  const findings = section(source.findings);
  const unresolvedRisks = section(source.unresolvedRisks);
  if (decision !== undefined) decision.unresolvedRisks = section(originalDecision?.unresolvedRisks);
  const evidenceGaps = section(source.evidenceGaps);
  const changedFiles = section(source.changedFiles);
  const checks = section(source.checks);
  if (decision !== undefined) {
    decision.objections = section(originalDecision?.objections);
    decision.participants = section(originalDecision?.participants);
  }
  const result: RunResultCenter = {
    status: source.status,
    finalAssessment,
    ...(failure === undefined ? {} : { failure }),
    ...(decision === undefined ? {} : { finalDecision: decision }),
    ...(finalRuling === undefined ? {} : { finalRuling }),
    findings,
    unresolvedRisks,
    evidenceGaps,
    changedFiles,
    checks,
    expectations: {
      changedFiles: source.expectations?.changedFiles ?? false,
      verification: source.expectations?.verification ?? true,
      finalRuling: source.expectations?.finalRuling ?? true,
    },
    providers: [],
    recoveredErrors: [],
    evidence: [],
  };
  const record = source as unknown as Record<string, unknown>;
  const identity = result as unknown as Record<string, unknown>;
  for (const key of ["executionRef", "resultVersion", "candidateHash", "candidateDigest", "session", "reference", "provenance", "metadata"]) {
    const value = single(record[key]);
    if (value !== undefined) identity[key] = value;
  }
  return { result, omitted: budget.omitted };
};

const wellFormedMarkdown = (text: string): boolean => {
  if (/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(text)) return false;
  let fence: { character: string; length: number } | undefined;
  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!marker) continue;
    const run = marker[1] ?? "";
    if (fence === undefined) fence = { character: run[0] ?? "", length: run.length };
    else if (run[0] === fence.character && run.length >= fence.length && !marker[2]?.trim()) fence = undefined;
  }
  return fence === undefined;
};

export const boundedMarkdown = (blocks: readonly string[], maximumUnits: number, omitted = false): string => {
  if (!Number.isInteger(maximumUnits) || maximumUnits < RESULT_OMISSION_NOTICE.length) {
    throw new RangeError("The result text limit must have room for the omission notice.");
  }
  const limit = Math.min(maximumUnits, RESULT_TEXT_LIMITS.readableMarkdownUnits);
  const retained: string[] = [];
  let length = 0;
  const contentLimit = limit - RESULT_OMISSION_NOTICE.length - 2;
  for (const block of blocks) {
    if (!block) continue;
    const separator = retained.length > 0 ? 2 : 0;
    if (block.length + length + separator > contentLimit || !wellFormedMarkdown(block)) {
      omitted = true;
      continue;
    }
    retained.push(block);
    length += separator + block.length;
  }
  if (omitted) retained.push(RESULT_OMISSION_NOTICE);
  return retained.join("\n\n");
};
