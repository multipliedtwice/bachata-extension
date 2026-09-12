import type { CycleBaseline, ExternalEvidenceRecord, FindingHistoryEntry } from "./types";

export type VerificationKind = "regression" | "reproduction" | "invariant" | "staticRule" | "externalEvidence";
export type VerificationCandidate = { commit: string; worktreeDigest: string };
export type FindingVerification = {
  version: 1;
  kind: VerificationKind;
  findingIdentity: string;
  findingStatement: string;
  requirement: string;
  scope: string[];
  candidate: VerificationCandidate;
  outcome: "passed" | "failed" | "inconclusive";
  verifier: string;
  environment: string;
  recordedAt: string;
  checkIdentity?: string;
  before?: { candidate: VerificationCandidate; checkIdentity: string; outcome: "failed" };
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/u.test(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (++count > allowed.length || !allowed.includes(key)) return false;
  }
  return true;
};
const candidate = (value: unknown): value is VerificationCandidate =>
  record(value) && keys(value, ["commit", "worktreeDigest"]) &&
  typeof value.commit === "string" && value.commit.length <= 64 &&
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})?$/u.test(value.commit) &&
  typeof value.worktreeDigest === "string" && value.worktreeDigest.length === 26 &&
  /^WT[A-F0-9]{24}$/u.test(value.worktreeDigest);
const timestamp = (value: unknown): number =>
  typeof value === "string" && value.length <= 40 ? Date.parse(value) : Number.NaN;
const kinds: readonly VerificationKind[] = ["regression", "reproduction", "invariant", "staticRule", "externalEvidence"];
const kind = (value: unknown): value is VerificationKind =>
  typeof value === "string" && kinds.some((item) => item === value);
const sameCandidate = (left: VerificationCandidate, right: VerificationCandidate): boolean =>
  left.commit === right.commit && left.worktreeDigest === right.worktreeDigest;

export const parseVerificationScope = (value: unknown): string[] | undefined => {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 1 || length > 32) return undefined;
    const scope: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const item: unknown = value[index];
      if (!text(item, 512) || /^(?:[/\\]|[A-Za-z]:)/u.test(item) || /[\u0000-\u001f\u007f]/u.test(item)) return undefined;
      const logical = item.replace(/\\/gu, "/");
      if (logical.split("/").some((part) => part.length === 0 || part === "." || part === "..") || scope.includes(logical)) return undefined;
      scope.push(logical);
    }
    return scope;
  } catch { return undefined; }
};

export const parseFindingVerification = (value: unknown): FindingVerification | undefined => {
  try {
    if (!record(value)) return undefined;
    const scope = parseVerificationScope(value.scope);
    if (!keys(value, ["version", "kind", "findingIdentity", "findingStatement", "requirement", "scope", "candidate", "outcome", "verifier", "environment", "recordedAt", "checkIdentity", "before"]) ||
        value.version !== 1 || !kind(value.kind) || !text(value.findingIdentity, 256) ||
        !text(value.findingStatement, 8000) || !text(value.requirement, 8000) ||
        !text(value.verifier, 256) || !text(value.environment, 2000) ||
        !text(value.recordedAt, 40) || !Number.isFinite(Date.parse(value.recordedAt)) ||
        !candidate(value.candidate) || scope === undefined ||
        (value.outcome !== "passed" && value.outcome !== "failed" && value.outcome !== "inconclusive")) return undefined;
    if (value.kind !== "externalEvidence" && !digest(value.checkIdentity)) return undefined;
    if (value.checkIdentity !== undefined && !digest(value.checkIdentity)) return undefined;
    let before: FindingVerification["before"];
    if (value.before !== undefined) {
      if (value.kind !== "regression" || !record(value.before) ||
          !keys(value.before, ["candidate", "checkIdentity", "outcome"]) ||
          !candidate(value.before.candidate) || !digest(value.before.checkIdentity) ||
          value.before.outcome !== "failed" || value.before.checkIdentity !== value.checkIdentity ||
          sameCandidate(value.before.candidate, value.candidate)) return undefined;
      before = { candidate: { ...value.before.candidate }, checkIdentity: value.before.checkIdentity, outcome: "failed" };
    }
    if (value.kind === "regression" && (before === undefined || value.outcome !== "passed")) return undefined;
    const parsed: FindingVerification = {
      version: 1, kind: value.kind, findingIdentity: value.findingIdentity,
      findingStatement: value.findingStatement, requirement: value.requirement, scope,
      candidate: { ...value.candidate }, outcome: value.outcome,
      verifier: value.verifier, environment: value.environment, recordedAt: value.recordedAt,
      ...(typeof value.checkIdentity === "string" ? { checkIdentity: value.checkIdentity } : {}),
      ...(before === undefined ? {} : { before }),
    };
    return Buffer.byteLength(JSON.stringify(parsed), "utf8") <= 32_768 ? parsed : undefined;
  } catch { return undefined; }
};

export const verificationCandidateFrom = (baseline: CycleBaseline | undefined): VerificationCandidate | undefined => {
  if (baseline?.contentComplete !== true) return undefined;
  const value = { commit: baseline.commit, worktreeDigest: baseline.worktreeDigest };
  return candidate(value) ? value : undefined;
};

export const findingVerificationRefusal = (input: {
  record: ExternalEvidenceRecord;
  finding: FindingHistoryEntry | undefined;
  currentBaseline: CycleBaseline | undefined;
  now: string;
}): string | undefined => {
  const { record: evidence, finding, currentBaseline, now } = input;
  const proof = parseFindingVerification(evidence.verification);
  if (!proof || !finding || evidence.target.kind !== "finding" ||
      evidence.target.identity !== finding.identity || proof.findingIdentity !== finding.identity ||
      proof.findingStatement !== finding.message) return "Verification does not cover the current finding";
  if (finding.state === "resolved" || finding.state === "rejected" || finding.humanResolution?.action === "defer") {
    return "The finding has a disposition that this evidence cannot replace";
  }
  if (finding.location && !proof.scope.includes(finding.location.file.replace(/\\/gu, "/"))) return "Verification does not cover the finding's file";
  if (proof.outcome !== "passed" || evidence.relation !== "supports") return "Verification does not report a passing resolution";
  const current = verificationCandidateFrom(currentBaseline);
  if (!current || !sameCandidate(proof.candidate, current)) return "Verification belongs to another candidate or the current inventory is incomplete";
  const time = timestamp(now);
  const recorded = timestamp(proof.recordedAt);
  const retrieved = timestamp(evidence.source.retrievedAt);
  if (!Number.isFinite(time) || !Number.isFinite(retrieved) || recorded > time || retrieved > time) return "Verification time is invalid";
  if (evidence.freshnessHorizonDays !== undefined && time - Math.min(recorded, retrieved) > evidence.freshnessHorizonDays * 86_400_000) {
    return "Verification has expired";
  }
  if (evidence.supersededById !== undefined || evidence.state === "superseded") return "Verification has been superseded";
  const ruledAt = evidence.humanResolution ? timestamp(evidence.humanResolution.resolvedAt) : 0;
  if (!Number.isFinite(ruledAt) || evidence.challenges.some((challenge) => {
    const challengedAt = timestamp(challenge.recordedAt);
    return !Number.isFinite(challengedAt) || challengedAt >= ruledAt;
  })) return "Verification has an unresolved or undated challenge";
  return undefined;
};
