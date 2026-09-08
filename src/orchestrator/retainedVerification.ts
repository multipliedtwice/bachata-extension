import { createHash } from "node:crypto";

import type { PatchSelection } from "./patchSelection";
import type { RetainedEvidenceSet, VerificationCheckResult } from "./types";

/**
 * P3. Whether a retained run's checks authorize applying it.
 *
 * A retained run holds its output in its own worktree until a person applies or discards it.
 * Applying is the moment the work reaches the workspace, and it was the one moment nothing
 * consulted the run's verification: `applyRetained` acquired ownership and applied. So "stale
 * verification blocks Apply" and "a valid rerun re-authorizes Apply" described behaviour that did
 * not exist.
 *
 * These are the decisions. Measuring the worktree, running the checks, persisting them and
 * applying the patch stay in the controller.
 */

export type RetainedCandidateState = {
  /**
   * The tree Apply would carry: the run's recorded integration tree, or the integration branch
   * when it has none. It is deliberately not the retained worktree's live state — Apply exports
   * the recorded tree, and so does verification, so an unrecorded edit changes neither.
   */
  candidate: string;
};

/**
 * What "this candidate" means for a retained run.
 *
 * The selection is folded in because a check run over the whole candidate says nothing about a
 * subset of it: applying selected files or hunks carries a different patch, and needs
 * verification of that patch. Two selections that name the same paths in the same order are the
 * same selection; anything else is a different one and needs its own evidence.
 */
export const retainedCandidateFingerprint = (
  state: RetainedCandidateState,
  selection?: PatchSelection | undefined,
): string =>
  createHash("sha256")
    .update(JSON.stringify({
      candidate: state.candidate,
      selection: selection === undefined ? null : selection,
    }))
    .digest("hex");

/** How many verified candidates a retained run remembers. */
export const RETAINED_EVIDENCE_LIMIT = 8;

/**
 * Record one verified candidate, newest last, bounded.
 *
 * A fingerprint that is recorded again replaces what it had rather than accumulating beside it:
 * a candidate has one current verification, and two records for one candidate would leave the
 * lookup deciding which of them counts.
 */
export const withRetainedEvidence = (
  existing: readonly RetainedEvidenceSet[] | undefined,
  next: RetainedEvidenceSet,
): RetainedEvidenceSet[] =>
  [...(existing ?? []).filter((entry) => entry.fingerprint !== next.fingerprint), next]
    .slice(-RETAINED_EVIDENCE_LIMIT);

export const retainedEvidenceSetFor = (
  evidence: readonly RetainedEvidenceSet[] | undefined,
  fingerprint: string,
): RetainedEvidenceSet | undefined =>
  (evidence ?? []).find((entry) => entry.fingerprint === fingerprint);

export const retainedEvidenceFor = (
  evidence: readonly RetainedEvidenceSet[] | undefined,
  fingerprint: string,
): VerificationCheckResult[] => retainedEvidenceSetFor(evidence, fingerprint)?.checks ?? [];

/**
 * What is wrong with a retained run's evidence, one required command at a time.
 *
 * The words are the same three the managed gate uses, and for the same reason: a check that never
 * ran, a check whose result belongs to another candidate, and a check that ran and did not pass
 * need different fixes, and a reader has to be able to tell them apart. Order follows the declared
 * commands so the list reads the same way twice.
 */
export const retainedVerificationIssues = (input: {
  required: readonly string[];
  checks: readonly VerificationCheckResult[];
  fingerprint: string;
}): string[] => {
  const byCommand = new Map(input.checks.map((check) => [check.command, check]));
  return input.required
    .map((command) => {
      const check = byCommand.get(command);
      if (!check) return `${command}: not run`;
      if (check.candidateTree !== input.fingerprint) return `${command}: stale`;
      return check.status === "passed" ? undefined : `${command}: ${check.status}`;
    })
    .filter((value): value is string => Boolean(value));
};

/**
 * Why this retained run may not be applied, or nothing.
 *
 * A run that declares no checks is not blocked: there is nothing to be missing. Everything else
 * needs a complete passing set for the exact candidate — and for the exact selection, when only
 * part of the candidate is being applied.
 */
export const retainedApplyRefusal = (input: {
  required: readonly string[];
  evidence: readonly RetainedEvidenceSet[] | undefined;
  fingerprint: string;
  selective: boolean;
  /** EX-A5-R01. The commit the receiving branch is on now. */
  target: string;
}): string | undefined => {
  if (input.required.length === 0) return undefined;
  const issues = retainedVerificationIssues({
    required: input.required,
    checks: retainedEvidenceFor(input.evidence, input.fingerprint),
    fingerprint: input.fingerprint,
  });
  // EX-A5-R01. Complete passing evidence is still only evidence about the branch it ran against.
  // A patch that applies cleanly says nothing about everything outside it, so a branch that has
  // moved since the checks is a composition this run has no evidence about at all. Asked after
  // the missing-and-failing checks, so a run that never ran them is still told that first.
  if (issues.length === 0) {
    const recorded = retainedEvidenceSetFor(input.evidence, input.fingerprint);
    if (recorded !== undefined && recorded.target !== input.target) {
      return [
        input.selective
          ? "This selection was verified against a different state of the receiving branch."
          : "This retained run was verified against a different state of the receiving branch.",
        recorded.target === undefined
          ? "Its verification does not record which commit it ran against."
          : `Verified against ${recorded.target.slice(0, 12)}; the branch is now on ${input.target.slice(0, 12)}.`,
        // EX-A5-R01 residue. Not "re-run the checks": a retained run's checks are composed on the
        // commit it started from, so re-running them would produce the same old composition under
        // a new label. Recomposing onto the moved branch is a feature that does not exist.
        "Rebase this work onto the branch and start a new run.",
      ].join(" ");
    }
    return undefined;
  }
  return [
    input.selective
      ? "This selection has no complete passing verification for the retained run as it stands."
      : "This retained run has no complete passing verification for its current candidate.",
    `Required verification: ${issues.join(", ")}`,
    "Re-run the retained checks and apply once they pass.",
  ].join(" ");
};
