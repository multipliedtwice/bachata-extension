import type { TranscriptEntry, WorkflowStatus } from "../webview/protocol";
import {
  parseEvidenceExpectations,
  UNKNOWN_EVIDENCE_EXPECTATIONS,
} from "./evidenceExpectations";
import type { EvidenceExpectations } from "./evidenceExpectations";
import {
  legacyModelFindingsFromRuling,
  mergeModelFindings,
  parseModelFindings,
} from "./modelFindings";
import type { ModelFinding } from "./modelFindings";
import {
  legacyRulingProvenance,
  parseRulingProvenance,
  rulingProvenanceDetail,
  rulingProvenanceRuledBy,
} from "./rulingProvenance";
import type { RulingProvenance } from "./rulingProvenance";

export type { EvidenceExpectations };
export type {
  RulingProvenance,
  RulingProvenanceKind,
  RulingParticipantIdentity,
} from "./rulingProvenance";
export type { ModelFinding } from "./modelFindings";

export type EvidenceState = "recorded" | "notApplicable" | "missing";
export type EvidenceKind = "changedFiles" | "verification" | "finalRuling" | "rulingProvenance";
export type EvidenceEntry = {
  kind: EvidenceKind;
  label: string;
  state: EvidenceState;
  detail: string;
};

export type FinalAssessmentOutcome = "completed" | "verificationFailed" | "inconclusive" | "notApplicable";
export type FinalAssessmentMethod = "consensus" | "arbiter" | "singleProvider" | "controller" | "none";
export type FinalAssessment = {
  outcome: FinalAssessmentOutcome;
  method: FinalAssessmentMethod;
  summary: string;
  producedBy: ResultProvider[];
};

export type VerificationResult = {
  command: string;
  status: "passed" | "failed" | "timedOut" | "cancelled";
  stale?: boolean;
  exitCode?: number;
  workingDirectory?: string;
  candidateTree?: string;
  outputReference?: string;
};
export type VerificationSource = "run" | "recheck";
export type VerificationProvenance = { source: VerificationSource; recordedAt: string };
export type RunRecheckRecord = {
  runId: string;
  recordedAt: string;
  checks: VerificationResult[];
};
export type ResultProvider = { name: string; adapter: string; model?: string };
export type RunResultCenter = {
  status: WorkflowStatus;
  changedFiles: string[];
  diffSummary?: string;
  checks: VerificationResult[];
  finalRuling?: string;
  rulingBy?: string;
  rulingProvenance?: RulingProvenance;
  consensusRuling?: boolean;
  providers: ResultProvider[];
  findings: ModelFinding[];
  unresolvedRisks: string[];
  recoveredErrors: string[];
  retainedWorktree?: string | undefined;
  retainedRunId?: string | undefined;
  executionRef?: string | undefined;
  expectations: EvidenceExpectations;
  evidence: EvidenceEntry[];
  evidenceGaps: string[];
  finalAssessment: FinalAssessment;
  verificationProvenance?: VerificationProvenance;
  applyBlockedReason?: string;
  applyOverrideReason?: string;
};

const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const agentRecoveryEventTypes = new Set([
  "agent.recovered",
  "provider.fallback",
]);

const runRecoveryEventTypes = new Set([
  "run.resumed",
  "iteration.resumed",
  "workflow.resumed",
]);

const sameUnit = (
  error: TranscriptEntry,
  candidate: TranscriptEntry,
): boolean =>
  error.agentId !== undefined &&
  candidate.agentId === error.agentId &&
  candidate.step === error.step;

const isRunScopedError = (error: TranscriptEntry): boolean =>
  error.agentId === undefined && error.step === undefined;

const errorIsRecovered = (
  error: TranscriptEntry,
  later: TranscriptEntry[],
): boolean =>
  later.some((candidate) => {
    if (candidate.kind === "answer") return sameUnit(error, candidate);
    if (candidate.eventType === undefined) return false;
    if (agentRecoveryEventTypes.has(candidate.eventType)) {
      return sameUnit(error, candidate);
    }
    if (runRecoveryEventTypes.has(candidate.eventType)) {
      return isRunScopedError(error);
    }
    return false;
  });

const partitionTranscriptErrors = (
  transcript: TranscriptEntry[],
): { unresolved: string[]; recovered: string[] } => {
  const unresolved: string[] = [];
  const recovered: string[] = [];
  transcript.forEach((entry, index) => {
    if (entry.kind !== "error") return;
    const later = transcript.slice(index + 1);
    (errorIsRecovered(entry, later) ? recovered : unresolved).push(entry.text);
  });
  return { unresolved, recovered };
};

const isStatus = (value: unknown): value is WorkflowStatus =>
  value === "idle" || value === "running" || value === "paused" ||
  value === "completed" || value === "interrupted" || value === "error";

const isCheckStatus = (value: unknown): value is VerificationResult["status"] =>
  value === "passed" || value === "failed" || value === "timedOut" || value === "cancelled";

const stringList = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parseChecks = (value: unknown): VerificationResult[] => Array.isArray(value)
  ? value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const check = item as Record<string, unknown>;
      return typeof check.command === "string" && isCheckStatus(check.status)
        ? [{
            command: check.command,
            status: check.status,
            ...(check.stale === true ? { stale: true } : {}),
            ...(typeof check.exitCode === "number" && Number.isInteger(check.exitCode)
              ? { exitCode: check.exitCode }
              : {}),
            ...(typeof check.workingDirectory === "string"
              ? { workingDirectory: check.workingDirectory }
              : {}),
            ...(typeof check.candidateTree === "string" && /^[0-9a-f]{40,64}$/u.test(check.candidateTree)
              ? { candidateTree: check.candidateTree }
              : {}),
            ...(typeof check.outputReference === "string"
              ? { outputReference: check.outputReference }
              : {}),
          }]
        : [];
    })
  : [];

export const parseVerificationProvenance = (
  value: unknown,
): VerificationProvenance | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const source = candidate.source;
  const recordedAt = optionalString(candidate.recordedAt);
  return (source === "run" || source === "recheck") && recordedAt !== undefined
    ? { source, recordedAt }
    : undefined;
};

export const parseRunRecheck = (value: unknown): RunRecheckRecord | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const runId = optionalString(candidate.runId);
  const recordedAt = optionalString(candidate.recordedAt);
  if (runId === undefined || recordedAt === undefined) return undefined;
  return { runId, recordedAt, checks: parseChecks(candidate.checks) };
};

export const mergeRecheckedChecks = (
  original: VerificationResult[] | undefined,
  rechecked: VerificationResult[],
): VerificationResult[] => {
  const covered = new Set(rechecked.map((check) => check.command));
  return [
    ...rechecked.map((check) => ({ ...check })),
    ...(original ?? [])
      .filter((check) => !covered.has(check.command))
      .map((check) => ({ ...check, stale: true })),
  ];
};

export const parseRunResult = (value: unknown): RunResultCenter | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isStatus(candidate.status)) return undefined;
  const checks = parseChecks(candidate.checks);
  const providers = Array.isArray(candidate.providers)
    ? candidate.providers.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const provider = item as Record<string, unknown>;
        return typeof provider.name === "string" && typeof provider.adapter === "string"
          ? [{
              name: provider.name,
              adapter: provider.adapter,
              ...(typeof provider.model === "string" ? { model: provider.model } : {}),
            }]
          : [];
      })
    : [];
  const status = candidate.status;
  const changedFiles = stringList(candidate.changedFiles);
  const finalRuling = optionalString(candidate.finalRuling);
  const persistedProvenance = parseRulingProvenance(candidate.rulingProvenance);
  const rulingBy = optionalString(candidate.rulingBy) ??
    rulingProvenanceRuledBy(persistedProvenance);
  const legacyConsensus = candidate.consensusRuling === true;
  const rulingProvenance = persistedProvenance ?? (
    legacyConsensus ? undefined : legacyRulingProvenance(rulingBy)
  );
  const findings = mergeModelFindings(
    parseModelFindings(candidate.findings),
    legacyModelFindingsFromRuling(finalRuling, rulingBy),
  );
  const consensusRuling = consensusRulingFor(persistedProvenance, legacyConsensus);
  const unresolvedRisks = stringList(candidate.unresolvedRisks);
  const expectations = parseEvidenceExpectations(candidate.expectations) ?? UNKNOWN_EVIDENCE_EXPECTATIONS;
  const persistedGaps = stringList(candidate.evidenceGaps);
  const evidence = evidenceLedgerFor({
    status,
    changedFiles,
    checks,
    ...(finalRuling === undefined ? {} : { finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    changedFilesRecorded: !persistedGaps.includes("Changed-file evidence was not recorded"),
    expectations,
  });
  const evidenceGaps = evidenceGapsFrom(evidence);
  const finalAssessment = finalAssessmentFor({
    status,
    checks,
    ...(finalRuling === undefined ? {} : { finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    providers,
    unresolvedRisks,
    unresolvedFindingCount: findings.filter((finding) => finding.disposition === "unresolved").length,
    expectations,
    evidenceGaps,
    consensus: consensusRuling,
  });
  const diffSummary = optionalString(candidate.diffSummary);
  return {
    status,
    changedFiles,
    ...(diffSummary === undefined ? {} : { diffSummary }),
    checks,
    ...(finalRuling === undefined ? {} : { finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    ...(consensusRuling ? { consensusRuling } : {}),
    providers,
    findings,
    unresolvedRisks,
    recoveredErrors: stringList(candidate.recoveredErrors),
    retainedWorktree: optionalString(candidate.retainedWorktree),
    retainedRunId: optionalString(candidate.retainedRunId),
    executionRef: optionalString(candidate.executionRef),
    expectations,
    evidence,
    evidenceGaps,
    finalAssessment,
    ...withVerificationState(
      { checks, expectations, assessment: finalAssessment },
      parseVerificationProvenance(candidate.verificationProvenance),
    ),
  };
};

export const runHandoffRefusal = (
  result: RunResultCenter | undefined,
  runId: string,
): string | undefined => {
  if (!result?.retainedRunId) {
    return `This run result is not bound to a retained orchestration run, so Bachata cannot act on ${runId}`;
  }
  return result.retainedRunId === runId
    ? undefined
    : `This run result belongs to ${result.retainedRunId}, not ${runId}. Bachata refuses to act on a different run than the one shown.`;
};

export const runResultHasEvidence = (result: RunResultCenter): boolean =>
  result.changedFiles.length > 0 ||
  result.checks.length > 0 ||
  result.finalRuling !== undefined ||
  result.findings.length > 0 ||
  result.unresolvedRisks.length > 0 ||
  result.recoveredErrors.length > 0 ||
  result.retainedWorktree !== undefined;

type EvidenceInput = {
  status: WorkflowStatus;
  changedFiles: string[];
  checks: VerificationResult[];
  finalRuling?: string;
  rulingBy?: string;
  rulingProvenance?: RulingProvenance;
  changedFilesRecorded: boolean;
  expectations: EvidenceExpectations;
};

const entry = (
  kind: EvidenceKind,
  label: string,
  state: EvidenceState,
  detail: string,
): EvidenceEntry => ({ kind, label, state, detail });

export const VERIFICATION_MISSING_DETAIL =
  "Expected but missing: no verification check was recorded";

export const VERIFICATION_STALE_DETAIL =
  "Expected but missing: every recorded check predates the current candidate";

export const evidenceLedgerFor = (result: EvidenceInput): EvidenceEntry[] => {
  const changedFiles = !result.expectations.changedFiles
    ? entry(
        "changedFiles",
        "Changed files",
        "notApplicable",
        "This contract grants no write authority, so changed files are not expected",
      )
    : result.changedFilesRecorded
      ? entry(
          "changedFiles",
          "Changed files",
          "recorded",
          `${String(result.changedFiles.length)} changed file${result.changedFiles.length === 1 ? "" : "s"} were recorded`,
        )
      : entry("changedFiles", "Changed files", "missing", "Changed-file evidence was not recorded");
  const verification = !result.expectations.verification
    ? entry(
        "verification",
        "Verification",
        "notApplicable",
        "This pipeline declares no controller-owned verification, so no check evidence is expected",
      )
    : result.checks.length > 0
      ? result.checks.every((check) => check.stale === true)
        ? entry("verification", "Verification", "missing", VERIFICATION_STALE_DETAIL)
        : entry(
            "verification",
            "Verification",
            "recorded",
            `${String(result.checks.length)} check${result.checks.length === 1 ? "" : "s"} were recorded${
              result.checks.some((check) => check.stale === true)
                ? `, ${String(result.checks.filter((check) => check.stale === true).length)} of them not re-run against the current candidate`
                : ""
            }`,
          )
      : entry("verification", "Verification", "missing", VERIFICATION_MISSING_DETAIL);
  const finalRuling = !result.expectations.finalRuling
    ? entry(
        "finalRuling",
        "Final ruling",
        "notApplicable",
        "This pipeline declares no consensus or checklist ruling, so no final ruling is expected",
      )
    : result.finalRuling
      ? entry("finalRuling", "Final ruling", "recorded", "A final ruling was recorded")
      : result.status === "completed"
        ? entry("finalRuling", "Final ruling", "missing", "No final ruling was recorded")
        : entry(
            "finalRuling",
            "Final ruling",
            "notApplicable",
            "The run has not completed, so no final ruling is expected yet",
          );
  const provenance = result.finalRuling === undefined
    ? entry(
        "rulingProvenance",
        "Ruling provenance",
        "notApplicable",
        "No final ruling was recorded, so there is no ruling provider to record",
      )
    : result.rulingProvenance
      ? entry(
          "rulingProvenance",
          "Ruling provenance",
          "recorded",
          rulingProvenanceDetail(result.rulingProvenance),
        )
      : result.rulingBy
        ? entry("rulingProvenance", "Ruling provenance", "recorded", `Ruled by ${result.rulingBy}`)
        : entry("rulingProvenance", "Ruling provenance", "missing", "The ruling provider was not recorded");
  return [changedFiles, verification, finalRuling, provenance];
};

const withVerificationState = (
  input: {
    checks: VerificationResult[];
    expectations: EvidenceExpectations;
    assessment: FinalAssessment;
  },
  provenance: VerificationProvenance | undefined,
): Pick<
  RunResultCenter,
  "verificationProvenance" | "applyBlockedReason" | "applyOverrideReason"
> => {
  const applyBlockedReason = applyBlockedReasonFor(input);
  const applyOverrideReason = applyBlockedReason === undefined &&
    input.assessment.outcome !== "completed"
    ? input.assessment.summary
    : undefined;
  return {
    ...(provenance === undefined ? {} : { verificationProvenance: provenance }),
    ...(applyBlockedReason === undefined ? {} : { applyBlockedReason }),
    ...(applyOverrideReason === undefined ? {} : { applyOverrideReason }),
  };
};

const evidenceGapsFrom = (evidence: EvidenceEntry[]): string[] =>
  evidence.filter((item) => item.state === "missing").map((item) => item.detail);

const failedCheck = (check: VerificationResult): boolean =>
  check.status === "failed" || check.status === "timedOut";

const cancelledCheck = (check: VerificationResult): boolean =>
  check.status === "cancelled";

const commandsOf = (checks: VerificationResult[]): string =>
  checks.map((check) => check.command).join(", ");

export const applyBlockedReasonFor = (input: {
  checks: VerificationResult[];
  expectations: EvidenceExpectations;
}): string | undefined => {
  const stale = input.checks.filter((check) => check.stale === true);
  if (stale.length > 0) {
    return `Verification is stale and was not re-run against this candidate: ${commandsOf(stale)}`;
  }
  const failures = input.checks.filter(failedCheck);
  if (failures.length > 0) {
    return `Verification did not pass: ${commandsOf(failures)}`;
  }
  const cancelled = input.checks.filter(cancelledCheck);
  if (cancelled.length > 0) {
    return `Verification was cancelled and proves nothing: ${commandsOf(cancelled)}`;
  }
  if (input.expectations.verification && input.checks.length === 0) {
    return "This pipeline declares controller verification, but no check result is recorded";
  }
  return undefined;
};

const assessmentMethodFrom = (
  provenance: RulingProvenance | undefined,
  legacyConsensus: boolean,
  providerCount: number,
): FinalAssessmentMethod => {
  if (provenance !== undefined) {
    if (provenance.kind === "unanimousConsensus") return "consensus";
    if (provenance.kind === "arbiterRuling") return "arbiter";
    if (provenance.kind === "singleProvider") return "singleProvider";
    if (provenance.kind === "controllerVerification") return "controller";
    return "none";
  }
  if (legacyConsensus && providerCount > 1) return "consensus";
  if (providerCount === 1) return "singleProvider";
  return "none";
};

const consensusRulingFor = (
  provenance: RulingProvenance | undefined,
  legacyConsensus: boolean,
): boolean => provenance === undefined
  ? legacyConsensus
  : provenance.kind === "unanimousConsensus";

export const finalAssessmentFor = (input: {
  status: WorkflowStatus;
  checks: VerificationResult[];
  finalRuling?: string;
  rulingBy?: string;
  providers: ResultProvider[];
  unresolvedRisks: string[];
  expectations: EvidenceExpectations;
  evidenceGaps: string[];
  consensus?: boolean;
  rulingProvenance?: RulingProvenance;
  unresolvedFindingCount?: number;
}): FinalAssessment => {
  const producedBy = input.providers;
  const method: FinalAssessmentMethod = input.checks.length > 0
    ? "controller"
    : assessmentMethodFrom(input.rulingProvenance, input.consensus === true, input.providers.length);
  if (input.status !== "completed") {
    return {
      outcome: input.status === "idle" || input.status === "running" ? "notApplicable" : "inconclusive",
      method,
      summary: `The run ended as ${input.status}, so no final assessment was produced`,
      producedBy,
    };
  }
  const stale = input.checks.filter((check) => check.stale === true);
  if (stale.length > 0) {
    return {
      outcome: "inconclusive",
      method: "controller",
      summary: `Controller verification is stale for ${commandsOf(stale)}`,
      producedBy,
    };
  }
  const failures = input.checks.filter(failedCheck);
  if (failures.length > 0) {
    return {
      outcome: "verificationFailed",
      method: "controller",
      summary: `Controller verification failed: ${commandsOf(failures)}`,
      producedBy,
    };
  }
  const cancelled = input.checks.filter(cancelledCheck);
  if (cancelled.length > 0) {
    return {
      outcome: "inconclusive",
      method: "controller",
      summary: `Controller verification was cancelled: ${commandsOf(cancelled)}`,
      producedBy,
    };
  }
  if (input.expectations.verification && input.checks.length === 0) {
    return {
      outcome: "inconclusive",
      method,
      summary: "This pipeline declares controller verification, but no check result was recorded",
      producedBy,
    };
  }
  if (input.unresolvedRisks.length > 0) {
    return {
      outcome: "inconclusive",
      method,
      summary: `${String(input.unresolvedRisks.length)} unresolved risk${input.unresolvedRisks.length === 1 ? "" : "s"} were recorded`,
      producedBy,
    };
  }
  if ((input.unresolvedFindingCount ?? 0) > 0) {
    const count = input.unresolvedFindingCount ?? 0;
    return {
      outcome: "inconclusive",
      method,
      summary: `${String(count)} model finding${count === 1 ? " needs" : "s need"} human resolution`,
      producedBy,
    };
  }
  if (input.expectations.finalRuling && input.finalRuling === undefined) {
    return {
      outcome: "inconclusive",
      method,
      summary: "This pipeline declares a ruling step, but no final ruling was recorded",
      producedBy,
    };
  }
  if (input.evidenceGaps.length > 0) {
    return {
      outcome: "inconclusive",
      method,
      summary: `Required evidence is missing: ${input.evidenceGaps.join("; ")}`,
      producedBy,
    };
  }
  return {
    outcome: "completed",
    method,
    summary: input.finalRuling ??
      "Every enabled step completed, no verification failed, and no unresolved risk was recorded",
    producedBy,
  };
};

const reconcileErrorClassification = (
  persisted: RunResultCenter,
  live: RunResultCenter,
): { unresolved: string[]; recovered: string[] } => {
  const liveUnresolved = new Set(live.unresolvedRisks);
  const liveRecovered = new Set(live.recoveredErrors);
  const recovered = unique([
    ...live.recoveredErrors,
    ...persisted.recoveredErrors.filter((value) => !liveUnresolved.has(value)),
  ]);
  const recoveredSet = new Set(recovered);
  const unresolved = unique([
    ...live.unresolvedRisks,
    ...persisted.unresolvedRisks.filter(
      (value) => !liveRecovered.has(value) && !recoveredSet.has(value),
    ),
  ]).filter((value) => !recoveredSet.has(value) || liveUnresolved.has(value));
  const finalUnresolved = new Set(unresolved);
  return {
    unresolved,
    recovered: recovered.filter((value) => !finalUnresolved.has(value)),
  };
};

export const mergeRunResults = (
  persisted: RunResultCenter,
  live: RunResultCenter,
): RunResultCenter => {
  if (
    persisted.executionRef !== undefined &&
    live.executionRef !== undefined &&
    persisted.executionRef !== live.executionRef
  ) {
    return live;
  }
  const changedFiles = live.changedFiles.length > 0 ? live.changedFiles : persisted.changedFiles;
  const liveOwnsChecks = live.checks.length > 0;
  const checks = liveOwnsChecks ? live.checks : persisted.checks;
  const verificationProvenance = liveOwnsChecks
    ? live.verificationProvenance
    : persisted.verificationProvenance;
  const finalRuling = live.finalRuling ?? persisted.finalRuling;
  const rulingSource = live.finalRuling === undefined ? persisted : live;
  const rulingBy = rulingSource.rulingBy;
  const rulingProvenance = rulingSource.rulingProvenance;
  const changedFilesRecorded = changedFiles.length > 0 ||
    !live.evidenceGaps.includes("Changed-file evidence was not recorded") ||
    !persisted.evidenceGaps.includes("Changed-file evidence was not recorded");
  const status = live.status === "idle" ? persisted.status : live.status;
  const reconciled = reconcileErrorClassification(persisted, live);
  const expectations = live.expectations ?? persisted.expectations ?? UNKNOWN_EVIDENCE_EXPECTATIONS;
  const providers = live.providers.length > 0 ? live.providers : persisted.providers;
  const findings = mergeModelFindings(persisted.findings, live.findings);
  const evidence = evidenceLedgerFor({
    status,
    changedFiles,
    checks,
    ...(finalRuling === undefined ? {} : { finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    changedFilesRecorded,
    expectations,
  });
  const evidenceGaps = evidenceGapsFrom(evidence);
  const consensusRuling = consensusRulingFor(
    rulingProvenance,
    live.consensusRuling === true || persisted.consensusRuling === true,
  );
  const finalAssessment = finalAssessmentFor({
    status,
    checks,
    ...(finalRuling === undefined ? {} : { finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    providers,
    unresolvedRisks: reconciled.unresolved,
    unresolvedFindingCount: findings.filter((finding) => finding.disposition === "unresolved").length,
    expectations,
    evidenceGaps,
    consensus: consensusRuling,
  });
  const mergedDiffSummary = live.diffSummary ?? persisted.diffSummary;
  return {
    status,
    ...(consensusRuling ? { consensusRuling: true } : {}),
    changedFiles,
    ...(mergedDiffSummary === undefined ? {} : { diffSummary: mergedDiffSummary }),
    checks,
    ...(finalRuling === undefined ? {} : { finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    providers,
    findings,
    unresolvedRisks: reconciled.unresolved,
    recoveredErrors: reconciled.recovered,
    ...(live.retainedWorktree ?? persisted.retainedWorktree
      ? { retainedWorktree: live.retainedWorktree ?? persisted.retainedWorktree }
      : {}),
    ...(live.retainedRunId ?? persisted.retainedRunId
      ? { retainedRunId: live.retainedRunId ?? persisted.retainedRunId }
      : {}),
    ...(live.executionRef ?? persisted.executionRef
      ? { executionRef: live.executionRef ?? persisted.executionRef }
      : {}),
    expectations,
    evidence,
    evidenceGaps,
    finalAssessment,
    ...withVerificationState(
      { checks, expectations, assessment: finalAssessment },
      verificationProvenance,
    ),
  };
};

export const projectRunResult = (input: {
  status: WorkflowStatus;
  transcript: TranscriptEntry[];
  changedFiles?: string[] | undefined;
  diffSummary?: string | undefined;
  checks?: VerificationResult[] | undefined;
  finalRuling?: string | undefined;
  rulingBy?: string | undefined;
  rulingProvenance?: RulingProvenance | undefined;
  providers?: ResultProvider[] | undefined;
  findings?: ModelFinding[] | undefined;
  unresolvedRisks?: string[] | undefined;
  retainedWorktree?: string | undefined;
  retainedRunId?: string | undefined;
  executionRef?: string | undefined;
  expectations?: EvidenceExpectations | undefined;
  verificationProvenance?: VerificationProvenance | undefined;
  consensusRuling?: boolean | undefined;
}): RunResultCenter => {
  const errors = partitionTranscriptErrors(input.transcript);
  const expectations = input.expectations ?? UNKNOWN_EVIDENCE_EXPECTATIONS;
  const providers = input.providers ?? [];
  const rulingProvenance = parseRulingProvenance(input.rulingProvenance);
  const rulingBy = input.rulingBy ?? rulingProvenanceRuledBy(rulingProvenance);
  const consensusRuling = consensusRulingFor(rulingProvenance, input.consensusRuling === true);
  const findings = mergeModelFindings(
    parseModelFindings(input.findings ?? []),
    legacyModelFindingsFromRuling(input.finalRuling, rulingBy),
  );
  const unresolvedRisks = unique([...(input.unresolvedRisks ?? []), ...errors.unresolved]);
  const evidence = evidenceLedgerFor({
    status: input.status,
    changedFiles: input.changedFiles ?? [],
    checks: input.checks ?? [],
    ...(input.finalRuling === undefined ? {} : { finalRuling: input.finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    changedFilesRecorded: input.changedFiles !== undefined,
    expectations,
  });
  const evidenceGaps = evidenceGapsFrom(evidence);
  const finalAssessment = finalAssessmentFor({
    status: input.status,
    checks: input.checks ?? [],
    ...(input.finalRuling === undefined ? {} : { finalRuling: input.finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    providers,
    unresolvedRisks,
    unresolvedFindingCount: findings.filter((finding) => finding.disposition === "unresolved").length,
    expectations,
    evidenceGaps,
    consensus: consensusRuling,
  });
  return {
    status: input.status,
    ...(consensusRuling ? { consensusRuling: true } : {}),
    changedFiles: unique(input.changedFiles ?? []),
    ...(input.diffSummary === undefined ? {} : { diffSummary: input.diffSummary }),
    checks: input.checks ?? [],
    ...(input.finalRuling === undefined ? {} : { finalRuling: input.finalRuling }),
    ...(rulingBy === undefined ? {} : { rulingBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
    providers,
    findings,
    unresolvedRisks,
    recoveredErrors: unique(errors.recovered),
    ...(input.retainedWorktree === undefined
      ? {}
      : { retainedWorktree: input.retainedWorktree }),
    ...(input.retainedRunId === undefined ? {} : { retainedRunId: input.retainedRunId }),
    ...(input.executionRef === undefined ? {} : { executionRef: input.executionRef }),
    expectations,
    evidence,
    evidenceGaps,
    finalAssessment,
    ...withVerificationState(
      { checks: input.checks ?? [], expectations, assessment: finalAssessment },
      input.verificationProvenance,
    ),
  };
};
