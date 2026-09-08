import { createHash } from "node:crypto";

import { gitReviewCommand } from "./commandDraft";
import type { GitReviewScope } from "./commandDraft";

export type ReviewScopeKind = GitReviewScope["scope"] | "file" | "selection" | "diagnostic";

export type ReviewCandidate = {
  kind: ReviewScopeKind;
  // Paths omitted from the dependency region, and why. Bounded result state, not a metric.
  regionOmissions?: Array<{ path: string; reason: string }>;
  // The exact command or path this review read. Recorded so a later reader can say what was
  // looked at, and never restate a delta review as a comprehensive one.
  source: string;
  comprehensive: false;
  inputDigest: string;
  paths?: string[];
  dependencyRegion?: string[];
};

const digestOf = (parts: readonly string[]): string =>
  createHash("sha256").update(parts.join(" "), "utf8").digest("hex");

/**
 * Identifies exactly what a delta review read, so its evidence can never be presented as a
 * comprehensive fresh review of the repository. The digest covers the scope, its refs, the
 * paths in scope and any bounded dependency region, so a repository that moves underneath
 * the review produces a different candidate and the earlier evidence reads as stale.
 */
export const reviewCandidate = (input: {
  scope: ReviewScopeKind;
  git?: Omit<GitReviewScope, "scope">;
  filePath?: string;
  paths?: readonly string[];
  dependencyRegion?: readonly string[];
  regionOmissions?: ReadonlyArray<{ path: string; reason: string }>;
}): ReviewCandidate => {
  const gitScope = input.scope === "file" ||
    input.scope === "selection" ||
    input.scope === "diagnostic"
    ? undefined
    : { scope: input.scope, ...(input.git ?? {}) };
  const source = gitScope === undefined
    ? input.filePath ?? input.scope
    : gitReviewCommand(gitScope);
  const paths = Array.from(new Set(input.paths ?? [])).sort();
  const dependencyRegion = Array.from(new Set(input.dependencyRegion ?? [])).sort();
  const omissions = (input.regionOmissions ?? [])
    .map((entry) => `${entry.path}:${entry.reason}`)
    .sort();
  return {
    kind: input.scope,
    source,
    comprehensive: false,
    // The region and its omissions are part of identity: a graph or configuration change
    // that yields a different region is a different candidate, so older evidence is stale.
    inputDigest: digestOf([
      input.scope,
      source,
      ...paths,
      "dependencies",
      ...dependencyRegion,
      "omissions",
      ...omissions,
    ]),
    ...(omissions.length === 0
      ? {}
      : { regionOmissions: [...(input.regionOmissions ?? [])].sort((a, b) =>
        a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)) }),
    ...(paths.length === 0 ? {} : { paths }),
    ...(dependencyRegion.length === 0 ? {} : { dependencyRegion }),
  };
};

export const reviewCandidatesMatch = (
  a: ReviewCandidate | undefined,
  b: ReviewCandidate | undefined,
): boolean => a !== undefined && b !== undefined && a.inputDigest === b.inputDigest;

/**
 * Human-readable statement of exactly what a review looked at, for exported evidence. It
 * always names the scope, so an export can never imply the whole repository was reviewed.
 */
export const reviewScopeStatement = (candidate: ReviewCandidate): string => {
  const paths = candidate.paths ?? [];
  const region = candidate.dependencyRegion ?? [];
  return [
    `Scope: ${candidate.kind} (${candidate.source}).`,
    "This was a delta review, not a comprehensive fresh review of the repository.",
    paths.length === 0
      ? "No changed path was recorded for this scope."
      : `${String(paths.length)} path${paths.length === 1 ? "" : "s"} in scope: ${paths.join(", ")}.`,
    region.length === 0
      ? "No dependency region was included."
      : `${String(region.length)} file${region.length === 1 ? "" : "s"} included as the affected dependency region: ${region.join(", ")}.`,
    `Input digest: ${candidate.inputDigest}.`,
  ].join(" ");
};
