import type { ModelFinding } from "../results/modelFindings";
import { canonicalFindingIdentity, findingIdentity } from "./lifecycle";
import type { FindingHistoryEntry, FindingReconciliationQuestion, RoundReconciliation } from "./types";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "do", "does",
  "for", "from", "has", "have", "in", "into", "is", "it", "its", "may", "no", "not", "of",
  "on", "or", "should", "that", "the", "then", "there", "this", "to", "was", "we", "when",
  "which", "will", "with", "would", "you", "your",
]);

const tokensOf = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  );

const overlapCoefficient = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  left.forEach((token) => {
    if (right.has(token)) shared += 1;
  });
  return shared / Math.min(left.size, right.size);
};

const normalizePath = (value: string): string => value.replaceAll("\\", "/").trim().toLowerCase();

type Located = { file?: string; startLine?: number; endLine?: number };

const locatedOf = (location: { file: string; startLine?: number; endLine?: number } | undefined): Located =>
  location === undefined
    ? {}
    : {
        file: normalizePath(location.file),
        ...(location.startLine === undefined ? {} : { startLine: location.startLine }),
        ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
      };

const LINE_PROXIMITY = 3;

const rangesTouch = (left: Located, right: Located): boolean => {
  if (left.startLine === undefined || right.startLine === undefined) return false;
  const leftEnd = left.endLine ?? left.startLine;
  const rightEnd = right.endLine ?? right.startLine;
  return left.startLine - LINE_PROXIMITY <= rightEnd && right.startLine - LINE_PROXIMITY <= leftEnd;
};

const locationScore = (left: Located, right: Located): number | undefined => {
  if (left.file === undefined || right.file === undefined) return 0;
  if (left.file !== right.file) return undefined;
  if (left.startLine === undefined || right.startLine === undefined) return 0.75;
  return rangesTouch(left, right) ? 1 : 0.5;
};

export const CLEAR_MATCH_SCORE = 50;
export const CLEAR_MATCH_SUBJECT_OVERLAP = 34;
export const CANDIDATE_SUBJECT_OVERLAP = 25;
export const AMBIGUOUS_MATCH_SCORE = 32;
export const CONTESTED_MARGIN = 8;

export type ReconciliationCandidate = {
  priorIdentity: string;
  subject: string;
  score: number;
  subjectOverlap: number;
  sameFile: boolean;
};

const percent = (value: number): number => Math.round(value * 100);

const bodyText = (input: { message: string; evidence: readonly string[] }): string =>
  `${input.message} ${input.evidence.join(" ")}`;

export const reconciliationCandidate = (
  fresh: ModelFinding,
  prior: FindingHistoryEntry,
): ReconciliationCandidate | undefined => {
  const freshLocation = locatedOf(fresh.location);
  const priorLocation = locatedOf(prior.location);
  const place = locationScore(freshLocation, priorLocation);
  if (place === undefined) return undefined;
  const subjectOverlap = percent(
    overlapCoefficient(tokensOf(fresh.subject), tokensOf(prior.subject)),
  );
  if (subjectOverlap < CANDIDATE_SUBJECT_OVERLAP) return undefined;
  const body = overlapCoefficient(
    tokensOf(bodyText(fresh)),
    tokensOf(bodyText({ message: prior.message, evidence: prior.evidence })),
  );
  return {
    priorIdentity: prior.identity,
    subject: prior.subject,
    score: Math.round(0.45 * percent(place) + 0.4 * subjectOverlap + 0.15 * percent(body)),
    subjectOverlap,
    sameFile:
      freshLocation.file !== undefined &&
      priorLocation.file !== undefined &&
      freshLocation.file === priorLocation.file,
  };
};

const rankedCandidates = (
  fresh: ModelFinding,
  history: readonly FindingHistoryEntry[],
): ReconciliationCandidate[] =>
  history
    .flatMap((prior) => {
      const candidate = reconciliationCandidate(fresh, prior);
      return candidate === undefined ? [] : [candidate];
    })
    .sort((left, right) =>
      right.score - left.score || left.priorIdentity.localeCompare(right.priorIdentity));

export type ReconciliationAssignment = {
  findingId: string;
  subject: string;
  freshIdentity: string;
  identity: string;
  kind: "exact" | "merged" | "new";
};

export type FindingReconciliation = {
  assignments: ReconciliationAssignment[];
  aliases: Array<{ aliasIdentity: string; canonicalIdentity: string; reason: string }>;
  questions: FindingReconciliationQuestion[];
};

const question = (
  fresh: ModelFinding,
  freshIdentity: string,
  kind: FindingReconciliationQuestion["kind"],
  detail: string,
  candidates: readonly ReconciliationCandidate[],
): FindingReconciliationQuestion => ({
  freshIdentity,
  subject: fresh.subject,
  kind,
  detail,
  candidates: candidates.map((candidate) => ({
    identity: candidate.priorIdentity,
    subject: candidate.subject,
    score: candidate.score,
  })),
});

export const reconcileFindings = (input: {
  findings: readonly ModelFinding[];
  history: readonly FindingHistoryEntry[];
  aliases?: ReadonlyMap<string, string>;
}): FindingReconciliation => {
  const aliases = input.aliases ?? new Map<string, string>();
  const tracked = new Set(input.history.map((entry) => entry.identity));
  const byIdentity = new Map(input.history.map((entry) => [entry.identity, entry]));
  const claimed = new Map<string, string>();
  const assignments: ReconciliationAssignment[] = [];
  const merged: FindingReconciliation["aliases"] = [];
  const questions: FindingReconciliationQuestion[] = [];

  const prepared = input.findings.map((finding) => {
    const freshIdentity = canonicalFindingIdentity(aliases, findingIdentity(finding));
    return { finding, freshIdentity, exact: tracked.has(freshIdentity) };
  });

  prepared
    .filter((item) => item.exact)
    .forEach((item) => {
      claimed.set(item.freshIdentity, item.finding.id);
      assignments.push({
        findingId: item.finding.id,
        subject: item.finding.subject,
        freshIdentity: item.freshIdentity,
        identity: item.freshIdentity,
        kind: "exact",
      });
    });

  const inexact = prepared
    .filter((item) => !item.exact)
    .map((item) => ({ ...item, candidates: rankedCandidates(item.finding, input.history) }))
    .sort((left, right) =>
      (right.candidates[0]?.score ?? 0) - (left.candidates[0]?.score ?? 0) ||
      left.freshIdentity.localeCompare(right.freshIdentity));

  inexact.forEach(({ finding, freshIdentity, candidates }) => {
    const best = candidates[0];
    const asNew = (): void => {
      claimed.set(freshIdentity, finding.id);
      assignments.push({
        findingId: finding.id,
        subject: finding.subject,
        freshIdentity,
        identity: freshIdentity,
        kind: "new",
      });
    };
    if (best === undefined || best.score < AMBIGUOUS_MATCH_SCORE) {
      asNew();
      return;
    }
    const runnerUp = candidates[1];
    const contested =
      runnerUp !== undefined && best.score - runnerUp.score <= CONTESTED_MARGIN;
    const clear =
      best.score >= CLEAR_MATCH_SCORE &&
      best.subjectOverlap >= CLEAR_MATCH_SUBJECT_OVERLAP &&
      !contested;
    if (!clear) {
      questions.push(question(
        finding,
        freshIdentity,
        "ambiguous",
        contested
          ? "This description matches more than one tracked finding equally well."
          : "This description partly matches a tracked finding. Bachata kept them separate.",
        candidates.slice(0, 3),
      ));
      asNew();
      return;
    }
    const priorEntry = byIdentity.get(best.priorIdentity);
    if (priorEntry?.humanResolution?.action === "reject") {
      questions.push(question(
        finding,
        freshIdentity,
        "conflict",
        "This description matches a finding you rejected. Bachata kept the new evidence separate instead of folding it into your ruling.",
        candidates.slice(0, 3),
      ));
      asNew();
      return;
    }
    const holder = claimed.get(best.priorIdentity);
    if (holder !== undefined) {
      questions.push(question(
        finding,
        freshIdentity,
        "split",
        `Another finding in this round already maps to ${best.priorIdentity}. Bachata tracked this one separately.`,
        candidates.slice(0, 3),
      ));
      asNew();
      return;
    }
    claimed.set(best.priorIdentity, finding.id);
    merged.push({
      aliasIdentity: freshIdentity,
      canonicalIdentity: best.priorIdentity,
      reason: `Bachata matched "${finding.subject}" to "${best.subject}" at a match score of ${String(best.score)}`,
    });
    assignments.push({
      findingId: finding.id,
      subject: finding.subject,
      freshIdentity,
      identity: best.priorIdentity,
      kind: "merged",
    });
  });

  return { assignments, aliases: merged, questions };
};

export const roundReconciliation = (
  reconciliation: FindingReconciliation,
): RoundReconciliation => ({
  merged: reconciliation.aliases.map((alias) => ({
    aliasIdentity: alias.aliasIdentity,
    canonicalIdentity: alias.canonicalIdentity,
  })),
  questions: reconciliation.questions,
});
