/**
 * EX-AUD-12, P3. Whether declared checks let a managed turn finish.
 *
 * This lived inside `createRuntime`'s managed browser-action loop, interleaved with the I/O that
 * carries it out. It is a decision and nothing else, so it is here and the runtime keeps the
 * calls around it.
 */

export type VerificationRecordLike = {
  id: string;
  status: string;
  /** The workspace this record was produced against. */
  workspaceFingerprint?: string | undefined;
};

export type VerificationCheckLike = { id: string };

/**
 * What is wrong with the declared checks, named one by one.
 *
 * Three ways a required check fails to authorize a turn, and they are deliberately different
 * words because they need different fixes:
 *
 * - `not run`: the check was declared and no record exists. Silence is not a pass. A check that
 *   never ran cannot be reported green, and it is the one case that would otherwise look like
 *   an absence of bad news.
 * - `stale`: a record exists but was produced against another workspace state. It describes a
 *   tree that is no longer the candidate, so it cannot authorize this one — this is what stops
 *   an earlier green run from carrying a later, different change.
 * - the check's own status: it ran against this workspace and did not pass. Reported in the
 *   provider's own word rather than flattened to "failed", because inconclusive is not failed
 *   and the Lead has to be able to tell them apart.
 *
 * Order follows the declared checks, not the records, so the list reads the same way twice and a
 * check that produced no record still has a place in it.
 */
export const verificationIssues = (
  required: readonly VerificationCheckLike[],
  records: readonly VerificationRecordLike[],
  workspaceFingerprint: string | undefined,
): string[] => {
  const byId = new Map(records.map((record) => [record.id, record]));
  return required
    .map(({ id }) => {
      const record = byId.get(id);
      if (!record) {
        return `${id}: not run`;
      }
      if (record.workspaceFingerprint !== workspaceFingerprint) {
        return `${id}: stale`;
      }
      return record.status === "passed" ? undefined : `${id}: ${record.status}`;
    })
    .filter((value): value is string => Boolean(value));
};

export type VerificationGateInput = {
  terminal: boolean;
  hasEnvelope: boolean;
  envelopeStatus?: string | undefined;
  issues: readonly string[];
  role: string;
  /** Objections and unresolved points the envelope still carries. */
  terminalObjections: readonly string[];
};

/**
 * Whether a turn that wants to finish must be held back over its checks.
 *
 * Only a terminal turn is gated: one still working has not claimed anything yet. A turn that
 * already reports itself blocked is not gated either, because it is not claiming success and
 * holding it again would say the same thing twice.
 *
 * The role difference is the point of the gate. A worker's turn is held on any check problem,
 * because a worker's claim is exactly "the work is done and verified". A lead's turn is held
 * only when it carries no objections of its own: a lead that has already written down what is
 * wrong is reporting a problem, and refusing that report over the checks would suppress the
 * finding rather than surface it.
 */
export const verificationGateHolds = (input: VerificationGateInput): boolean =>
  input.terminal
  && input.hasEnvelope
  && input.envelopeStatus !== "blocked"
  && input.issues.length > 0
  && (input.role === "worker" || input.terminalObjections.length === 0);
