import type { JsonValue } from "../adapters/types";
import type { RunResultCenter, ResultProvider, RunFailure, EvidenceEntry, VerificationResult } from "./projectResult";
import { applyBlockedReasonFor } from "./projectResult";
import { parseEvidenceExpectations, UNKNOWN_EVIDENCE_EXPECTATIONS } from "./evidenceExpectations";
import { parseModelFinding } from "./modelFindings";
import { parseRulingProvenance } from "./rulingProvenance";
import { RESULT_TEXT_LIMITS } from "./textLimits";
import { createOpaqueResultScrubber, readableResultFields } from "./readableResult";

export const TERMINAL_RESULT_OMISSION_NOTICE = "Some recorded result material was omitted from this saved summary because catalog limits were reached. Consult the recorded event history for retained details; omitted material does not establish acceptance or verification.";

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const entryByteLimit = RESULT_TEXT_LIMITS.catalogJsonBytes / 8;
const entryVisitLimit = RESULT_TEXT_LIMITS.maximumVisitedEntries / 8;
const omittedText = "Recorded text omitted from this saved summary; consult the recorded event history.";

const providerOf = (value: JsonValue): ResultProvider | undefined => {
  const record = recordOf(value);
  if (!record || typeof record.name !== "string" || typeof record.adapter !== "string") return undefined;
  return {
    name: record.name,
    adapter: record.adapter,
    ...Object.fromEntries(["model", "agentId", "provider"].flatMap((key) =>
      typeof record[key] === "string" ? [[key, record[key]]] : [])),
  };
};

const failureOf = (value: JsonValue): RunFailure | undefined => {
  const record = recordOf(value);
  if (!record || typeof record.error !== "string") return undefined;
  return {
    error: record.error,
    ...Object.fromEntries(["agentId", "participant", "adapter", "provider", "model", "step"].flatMap((key) =>
      typeof record[key] === "string" ? [[key, record[key]]] : [])),
  };
};

const checkOf = (value: JsonValue): VerificationResult | undefined => {
  const record = recordOf(value);
  if (!record || typeof record.command !== "string" ||
      (record.status !== "passed" && record.status !== "failed" && record.status !== "timedOut" && record.status !== "cancelled")) return undefined;
  return {
    command: record.command,
    status: record.status,
    ...(record.stale === true ? { stale: true } : {}),
    ...(Number.isInteger(record.exitCode) ? { exitCode: record.exitCode as number } : {}),
    ...(typeof record.workingDirectory === "string" ? { workingDirectory: record.workingDirectory } : {}),
    ...(typeof record.candidateTree === "string" && /^[0-9a-f]{40,64}$/u.test(record.candidateTree)
      ? { candidateTree: record.candidateTree } : {}),
    ...(typeof record.outputReference === "string" ? { outputReference: record.outputReference } : {}),
  };
};

const evidenceOf = (value: JsonValue): EvidenceEntry | undefined => {
  const record = recordOf(value);
  if (!record || typeof record.label !== "string" || typeof record.detail !== "string" ||
      (record.kind !== "changedFiles" && record.kind !== "verification" && record.kind !== "finalRuling" && record.kind !== "rulingProvenance") ||
      (record.state !== "recorded" && record.state !== "notApplicable" && record.state !== "missing")) return undefined;
  return { kind: record.kind, label: record.label, state: record.state, detail: record.detail };
};

export const boundedTerminalResult = (source: RunResultCenter): RunResultCenter => {
  let omitted = source.persistence?.omitted === true;
  let visits = 0;
  let examinedText = 0;
  const scrub = createOpaqueResultScrubber(source);
  const proseKeys = new Set([...Object.keys(readableResultFields), "diffSummary", "applyBlockedReason", "applyOverrideReason", "recoveredErrors"]);
  const copy = (value: unknown, owner = ""): JsonValue | undefined => {
    let entryVisits = 0;
    let entryText = 0;
    let projectedText = 0;
    let invalid = false;
    const visit = (item: unknown, depth: number, key: string): JsonValue | undefined => {
      if (visits >= RESULT_TEXT_LIMITS.maximumVisitedEntries || entryVisits >= entryVisitLimit || depth > RESULT_TEXT_LIMITS.maximumDepth) {
        invalid = true;
        return undefined;
      }
      visits += 1;
      entryVisits += 1;
      if (typeof item === "string") {
        if (item.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits - entryText ||
            item.length > RESULT_TEXT_LIMITS.maximumInputTextUnits - examinedText) {
          invalid = true;
          return undefined;
        }
        entryText += item.length;
        examinedText += item.length;
        const visible = proseKeys.has(key) ? scrub(item) : item;
        if (visible.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits - projectedText) {
          invalid = true;
          return undefined;
        }
        projectedText += visible.length;
        return visible;
      }
      if (item === null || typeof item === "boolean") return item;
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (Array.isArray(item)) {
        if (item.length > RESULT_TEXT_LIMITS.maximumSectionEntries) {
          invalid = true;
          return undefined;
        }
        const output: JsonValue[] = [];
        for (const child of item) {
          const projected = visit(child, depth + 1, key);
          if (invalid || projected === undefined) {
            invalid = true;
            return undefined;
          }
          output.push(projected);
        }
        return output;
      }
      const record = recordOf(item);
      if (!record) {
        invalid = true;
        return undefined;
      }
      const output: { [key: string]: JsonValue } = {};
      let fields = 0;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        fields += 1;
        if (fields > RESULT_TEXT_LIMITS.maximumSectionEntries) {
          invalid = true;
          return undefined;
        }
        if (record[key] === undefined) continue;
        if (visit(key, depth + 1, "") === undefined) return undefined;
        const projected = visit(record[key], depth + 1, key);
        if (invalid || projected === undefined) return undefined;
        Object.defineProperty(output, key, { value: projected, enumerable: true, writable: true, configurable: true });
      }
      return output;
    };
    const output = visit(value, 0, owner);
    if (invalid || output === undefined || jsonBytes(output) > entryByteLimit) {
      omitted = true;
      return undefined;
    }
    return output;
  };
  const assessment = recordOf(source.finalAssessment);
  const outcome = assessment?.outcome;
  const method = assessment?.method;
  const result: RunResultCenter = {
    status: source.status === "completed" || source.status === "interrupted" ? source.status : "error",
    changedFiles: [],
    checks: [],
    providers: [],
    findings: [],
    unresolvedRisks: [],
    recoveredErrors: [],
    expectations: parseEvidenceExpectations(source.expectations) ?? { ...UNKNOWN_EVIDENCE_EXPECTATIONS },
    evidence: [],
    evidenceGaps: [],
    finalAssessment: {
      outcome: outcome === "completed" || outcome === "verificationFailed" || outcome === "failedBeforeRuling" || outcome === "notApplicable" ? outcome : "inconclusive",
      method: method === "consensus" || method === "arbiter" || method === "singleProvider" || method === "controller" ? method : "none",
      summary: omittedText,
      producedBy: [],
    },
    persistence: { version: 1, omitted: false },
  };
  let retainedBytes = jsonBytes(result);
  const maximumBytes = RESULT_TEXT_LIMITS.catalogJsonBytes - jsonBytes(TERMINAL_RESULT_OMISSION_NOTICE) -
    jsonBytes({ applyBlockedReason: TERMINAL_RESULT_OMISSION_NOTICE }) - 4;
  const set = (target: object, key: string, value: unknown): boolean => {
    const record = target as Record<string, unknown>;
    const added = Object.prototype.hasOwnProperty.call(record, key)
      ? jsonBytes(value) - jsonBytes(record[key])
      : jsonBytes(key) + 1 + jsonBytes(value) + (Object.keys(record).length > 0 ? 1 : 0);
    if (retainedBytes + added > maximumBytes) {
      omitted = true;
      return false;
    }
    record[key] = value;
    retainedBytes += added;
    return true;
  };
  const field = (target: object, key: string, value: unknown, parse: (value: JsonValue) => unknown = (entry) => entry): void => {
    if (value === undefined) return;
    const copied = copy(value, key);
    const parsed = copied === undefined ? undefined : parse(copied);
    if (parsed === undefined) omitted = true;
    else set(target, key, parsed);
  };
  const stringOf = (value: JsonValue): string | undefined => typeof value === "string" ? value : undefined;
  for (const key of ["executionRef", "retainedRunId", "retainedWorktree"] as const) field(result, key, source[key], stringOf);
  if (Number.isSafeInteger(source.finalDecisionEventId) && Number(source.finalDecisionEventId) > 0) set(result, "finalDecisionEventId", source.finalDecisionEventId);
  field(result.finalAssessment, "summary", assessment?.summary, stringOf);
  const failure = (target: object, value: unknown): void => {
    const record = recordOf(value);
    if (!record) return;
    const copied = copy(record);
    const parsed = copied === undefined ? undefined : failureOf(copied);
    if (parsed) set(target, "failure", parsed);
    else {
      omitted = true;
      const fallback: RunFailure = { error: omittedText };
      for (const key of ["agentId", "participant", "adapter", "provider", "model", "step"] as const) {
        const text = typeof record[key] === "string" ? copy(record[key]) : undefined;
        if (typeof text === "string") {
          const proposed = { ...fallback, [key]: text };
          const textUnits = Object.entries(proposed).reduce((total, [name, item]) => total + name.length + item.length, 0);
          if (textUnits <= RESULT_TEXT_LIMITS.maximumEntryTextUnits && jsonBytes(proposed) <= entryByteLimit) fallback[key] = text;
          else omitted = true;
        }
      }
      const boundedFallback = copy(fallback);
      if (boundedFallback === undefined || !set(target, "failure", boundedFallback)) set(target, "failure", { error: omittedText });
    }
  };
  failure(result, source.failure);
  failure(result.finalAssessment, assessment?.failure);
  const decision = recordOf(source.finalDecision);
  if (decision && (decision.status === "pending" || decision.status === "accepted" || decision.status === "ruled" || decision.status === "resolved")) {
    const stepId = copy(decision.stepId);
    if (typeof stepId === "string") {
      set(result, "finalDecision", { stepId, status: decision.status, participants: [], objections: [], unresolvedRisks: [] });
      if (result.finalDecision) {
        field(result.finalDecision, "candidate", decision.candidate);
        if (decision.candidate !== undefined && result.finalDecision.candidate === undefined) set(result.finalDecision, "candidate", omittedText);
        field(result.finalDecision, "ruledBy", decision.ruledBy, stringOf);
        const resolution = recordOf(decision.humanResolution);
        if (resolution && (resolution.action === "acceptParticipant" || resolution.action === "acceptUnresolved") &&
            typeof resolution.rationale === "string" && typeof resolution.resolvedAt === "string") {
          const resolvedAt = copy(resolution.resolvedAt);
          const rationale = copy(resolution.rationale, "rationale");
          const selectedParticipant = resolution.selectedParticipant === undefined ? undefined : copy(resolution.selectedParticipant);
          if (typeof resolvedAt === "string") set(result.finalDecision, "humanResolution", {
            action: resolution.action, resolvedAt, rationale: typeof rationale === "string" ? rationale : omittedText,
            ...(typeof selectedParticipant === "string" ? { selectedParticipant } : {}),
          });
        } else if (decision.humanResolution !== undefined) omitted = true;
      }
    } else omitted = true;
  }
  field(result, "finalRuling", source.finalRuling, stringOf);
  if (source.finalRuling !== undefined && result.finalRuling === undefined) set(result, "finalRuling", omittedText);
  field(result, "rulingBy", source.rulingBy, stringOf);
  field(result, "rulingProvenance", source.rulingProvenance, parseRulingProvenance);
  if (source.consensusRuling === true) set(result, "consensusRuling", true);
  field(result, "verificationProvenance", source.verificationProvenance, (value) => {
    const provenance = recordOf(value);
    return provenance && (provenance.source === "run" || provenance.source === "recheck") && typeof provenance.recordedAt === "string"
      ? { source: provenance.source, recordedAt: provenance.recordedAt }
      : undefined;
  });
  type Collection = { source: unknown[]; target: unknown[]; parse: (value: JsonValue) => unknown; length: number; owner: string };
  const collections: Collection[] = [];
  const collection = (value: unknown, target: unknown[], parse: Collection["parse"] = (entry) => entry, owner = ""): void => {
    if (!Array.isArray(value)) return;
    const length = value.length - (target === result.evidenceGaps && value.at(-1) === TERMINAL_RESULT_OMISSION_NOTICE ? 1 : 0);
    if (length > RESULT_TEXT_LIMITS.maximumSectionEntries) omitted = true;
    collections.push({ source: value, target, parse, length, owner });
  };
  collection(source.findings, result.findings, parseModelFinding);
  collection(source.unresolvedRisks, result.unresolvedRisks, stringOf, "unresolvedRisks");
  collection(source.evidenceGaps, result.evidenceGaps, stringOf, "evidenceGaps");
  collection(source.checks, result.checks, checkOf);
  collection(source.changedFiles, result.changedFiles, stringOf, "changedFiles");
  collection(source.evidence, result.evidence, evidenceOf);
  collection(source.providers, result.providers, providerOf);
  collection(assessment?.producedBy, result.finalAssessment.producedBy, providerOf);
  if (result.finalDecision) {
    collection(decision?.unresolvedRisks, result.finalDecision.unresolvedRisks, stringOf, "unresolvedRisks");
    collection(decision?.objections, result.finalDecision.objections);
    collection(decision?.participants, result.finalDecision.participants);
  }
  collection(source.recoveredErrors, result.recoveredErrors, stringOf, "recoveredErrors");
  for (let index = 0; index < RESULT_TEXT_LIMITS.maximumSectionEntries; index += 1) {
    for (const entry of collections) {
      if (index >= entry.length) continue;
      const copied = copy(entry.source[index], entry.owner);
      const parsed = copied === undefined ? undefined : entry.parse(copied);
      if (parsed === undefined) {
        omitted = true;
        continue;
      }
      const added = jsonBytes(parsed) + (entry.target.length > 0 ? 1 : 0);
      if (retainedBytes + added > maximumBytes) {
        omitted = true;
        continue;
      }
      entry.target.push(parsed);
      retainedBytes += added;
    }
  }
  field(result, "diffSummary", source.diffSummary, stringOf);
  const blockedReason = applyBlockedReasonFor(result) ?? source.applyBlockedReason;
  if (typeof blockedReason === "string" && blockedReason.length > 0) {
    const visible = blockedReason.length <= RESULT_TEXT_LIMITS.maximumEntryTextUnits ? scrub(blockedReason) : undefined;
    if (visible === undefined || visible.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits ||
        jsonBytes(visible) > entryByteLimit || !set(result, "applyBlockedReason", visible)) {
      omitted = true;
      result.applyBlockedReason = TERMINAL_RESULT_OMISSION_NOTICE;
    }
  }
  if (!omitted && !result.applyBlockedReason && result.finalAssessment.outcome !== "completed") {
    set(result, "applyOverrideReason", result.finalAssessment.summary);
  }
  if (omitted && !result.applyBlockedReason) {
    delete result.applyOverrideReason;
    result.applyBlockedReason = TERMINAL_RESULT_OMISSION_NOTICE;
  }
  if (omitted) result.evidenceGaps.push(TERMINAL_RESULT_OMISSION_NOTICE);
  result.persistence = { version: 1, omitted };
  return result;
};
