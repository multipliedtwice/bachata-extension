import type { RunResultCenter } from "../results/projectResult";
import type { ModelFinding } from "../results/modelFindings";
import {
  excludedByPolicy,
  excludedPathTokensIn,
  maskExcludedPaths,
  type ExportPolicy,
} from "./exportPolicy";

export type EvidenceExclusion = {
  result: RunResultCenter;
  excludedPaths: string[];
  excludedFindingIds: string[];
  excludedEntryCount: number;
};

const findingText = (finding: ModelFinding): string[] => [
  finding.subject,
  finding.message,
  ...finding.evidence,
  ...finding.challenges,
  ...(finding.location === undefined ? [] : [finding.location.file]),
];

export const excludeEvidencePaths = (
  result: RunResultCenter,
  policy: ExportPolicy | undefined,
): EvidenceExclusion => {
  if (!policy || policy.excludePathPrefixes.length === 0) {
    return { result, excludedPaths: [], excludedFindingIds: [], excludedEntryCount: 0 };
  }
  const excludedPaths: string[] = [];
  const record = (value: string): void => {
    if (!excludedPaths.includes(value)) excludedPaths.push(value);
  };
  const mask = (value: string): string => maskExcludedPaths(value, policy, record);
  const carriesExcluded = (value: string): boolean => {
    const tokens = excludedPathTokensIn(value, policy);
    tokens.forEach(record);
    return tokens.length > 0;
  };
  const keepEntry = (value: string): boolean => !carriesExcluded(value);

  const changedFiles = (result.changedFiles ?? []).filter((file) => {
    if (excludedByPolicy([file], policy).length === 0) return true;
    record(file);
    return false;
  });

  const excludedFindingIds: string[] = [];
  const findings = (result.findings ?? []).filter((finding) => {
    const carries = findingText(finding).some((value) => carriesExcluded(value));
    if (carries) excludedFindingIds.push(finding.id);
    return !carries;
  });

  const unresolvedRisks = (result.unresolvedRisks ?? []).filter(keepEntry);
  const recoveredErrors = (result.recoveredErrors ?? []).filter(keepEntry);
  const evidenceGaps = (result.evidenceGaps ?? []).filter(keepEntry);
  const checks = (result.checks ?? []).filter((check) => keepEntry(check.command));
  const evidence = (result.evidence ?? []).map((item) => ({ ...item, detail: mask(item.detail) }));
  const excludedEntryCount =
    ((result.unresolvedRisks ?? []).length - unresolvedRisks.length) +
    ((result.recoveredErrors ?? []).length - recoveredErrors.length) +
    ((result.evidenceGaps ?? []).length - evidenceGaps.length) +
    ((result.checks ?? []).length - checks.length);

  return {
    result: {
      ...result,
      changedFiles,
      checks,
      findings,
      unresolvedRisks,
      recoveredErrors,
      evidenceGaps,
      evidence,
      ...(result.diffSummary === undefined ? {} : { diffSummary: mask(result.diffSummary) }),
      ...(result.finalRuling === undefined ? {} : { finalRuling: mask(result.finalRuling) }),
      ...(result.retainedWorktree === undefined
        ? {}
        : { retainedWorktree: mask(result.retainedWorktree) }),
      ...(result.finalAssessment === undefined
        ? {}
        : {
            finalAssessment: {
              ...result.finalAssessment,
              summary: mask(result.finalAssessment.summary),
            },
          }),
      ...(result.applyBlockedReason === undefined
        ? {}
        : { applyBlockedReason: mask(result.applyBlockedReason) }),
      ...(result.applyOverrideReason === undefined
        ? {}
        : { applyOverrideReason: mask(result.applyOverrideReason) }),
      ...(result.providers === undefined
        ? {}
        : {
            providers: result.providers.map((provider) => ({
              ...provider,
              name: mask(provider.name),
              adapter: mask(provider.adapter),
              ...(provider.model === undefined ? {} : { model: mask(provider.model) }),
            })),
          }),
      ...(result.rulingBy === undefined ? {} : { rulingBy: mask(result.rulingBy) }),
    },
    excludedPaths,
    excludedFindingIds,
    excludedEntryCount,
  };
};

export const evidenceExclusionOmissions = (
  exclusion: EvidenceExclusion,
  policyPath: string,
): string[] => [
  ...(exclusion.excludedPaths.length > 0
    ? [`${String(exclusion.excludedPaths.length)} repository paths were excluded from every evidence section by ${policyPath}.`]
    : []),
  ...(exclusion.excludedFindingIds.length > 0
    ? [`${String(exclusion.excludedFindingIds.length)} model findings were withheld because they reference excluded paths.`]
    : []),
  ...(exclusion.excludedEntryCount > 0
    ? [`${String(exclusion.excludedEntryCount)} risk, check, or evidence-gap entries were withheld because they reference excluded paths.`]
    : []),
];
