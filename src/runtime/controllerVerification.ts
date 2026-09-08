import { verificationIssues } from "./verificationGate";

/**
 * P3. Controller-owned verification, for every managed turn that declares checks.
 *
 * The shipped `feature-delivery` preset declares `managedPolicy.verificationChecks`, and every
 * turn in a run is handed them — but only the managed *browser* turn ever executed one, so a
 * pipeline whose Worker and Lead prefer local adapters reached `lead-review` with its declared
 * checks inert. Verification is the controller's, not the adapter's: what a check is, whether it
 * ran, what it produced and whether it authorizes an advance cannot depend on which provider the
 * turn happened to use.
 *
 * These are the decisions. Running the checks, writing the transcript and sending the next turn
 * stay in `createRuntime`. Nothing here widens command authority: which commands may run at all
 * is still decided by `orchestrator/verificationPolicy.ts` and its existing human approval.
 */

export type ControllerCheck = {
  id: string;
  command: string;
};

export type ControllerVerificationRecord = {
  id: string;
  status: string;
  command?: string | undefined;
  exitCode?: number | undefined;
  summary?: string | undefined;
  workspaceFingerprint?: string | undefined;
};

/**
 * The checks a run must satisfy, read from the pipeline snapshot it started with.
 *
 * The snapshot is immutable for the life of the run, so this is the one list: a check cannot be
 * added or dropped mid-run by editing the catalog. Duplicate ids collapse to the first, because a
 * check named twice is one check and counting it twice would let one result satisfy two entries.
 */
export const requiredControllerChecks = (
  declared: readonly ControllerCheck[] | undefined,
): ControllerCheck[] => {
  const seen = new Set<string>();
  return (declared ?? []).filter((check) => {
    if (typeof check.id !== "string" || check.id.length === 0) return false;
    if (seen.has(check.id)) return false;
    seen.add(check.id);
    return true;
  }).map((check) => ({ id: check.id, command: check.command }));
};

/**
 * The statuses that are not a pass.
 *
 * Written out rather than inferred from "not passed" so the list is reviewable: a skipped check
 * did not run, an inconclusive one ran and proved nothing, and a cancelled one was stopped. None
 * of them is evidence, and none of them may be reported as an absence of bad news.
 */
export const CONTROLLER_VERIFICATION_NON_PASSING = [
  "failed",
  "skipped",
  "inconclusive",
  "cancelled",
  "unknown",
];

export type ControllerVerificationAuthorization = {
  authorized: boolean;
  /** One line per required check that is not passing, in the declared order. */
  issues: string[];
};

/**
 * Whether the declared checks authorize this candidate to advance.
 *
 * The records are matched to the candidate by its workspace fingerprint, which is what makes a
 * newly changed candidate invalidate an older passing result: the record describes a tree that is
 * no longer the one being advanced, so it is stale rather than green.
 */
export const controllerVerificationAuthorizes = (input: {
  required: readonly ControllerCheck[];
  records: readonly ControllerVerificationRecord[];
  workspaceFingerprint: string | undefined;
}): ControllerVerificationAuthorization => {
  const issues = verificationIssues(input.required, input.records, input.workspaceFingerprint);
  return { authorized: issues.length === 0, issues };
};

/**
 * The records that still describe this candidate.
 *
 * Applied before anything is reported or persisted, so a result produced against an earlier tree
 * is dropped rather than carried forward as evidence for a later one.
 */
export const controllerVerificationForCandidate = <T extends ControllerVerificationRecord>(
  records: readonly T[],
  workspaceFingerprint: string | undefined,
): T[] =>
  records.filter((record) => record.workspaceFingerprint === workspaceFingerprint);

export type ControllerEvidenceLine = {
  id: string;
  command: string;
  status: string;
  exitCode?: number | undefined;
  output: string;
};

/**
 * What the Lead is given about each required check.
 *
 * Exact and per check: the id it was declared under, the command the controller ran, the status
 * it produced, the exit information where a process produced one, and its output truncated to a
 * stated bound. A check that produced no record at all is reported as `not run` rather than
 * omitted, because an omission reads as an absence of problems.
 *
 * A record that carries a summary and nothing else does not replace this. The summary is the
 * output field, and the id, command and status beside it are the controller's own, so a provider
 * that returned prose in place of a result cannot present it as a passing check.
 */
export const controllerVerificationEvidence = (input: {
  required: readonly ControllerCheck[];
  records: readonly ControllerVerificationRecord[];
  workspaceFingerprint: string | undefined;
  maxOutputBytes?: number | undefined;
}): ControllerEvidenceLine[] => {
  const limit = Math.max(0, input.maxOutputBytes ?? 8_192);
  const current = controllerVerificationForCandidate(input.records, input.workspaceFingerprint);
  const byId = new Map(current.map((record) => [record.id, record]));
  return input.required.map((check) => {
    const record = byId.get(check.id);
    return {
      id: check.id,
      command: check.command,
      status: record ? record.status : "not run",
      ...(typeof record?.exitCode === "number" ? { exitCode: record.exitCode } : {}),
      output: (record?.summary ?? "").slice(0, limit),
    };
  });
};

export const renderControllerVerificationEvidence = (
  lines: readonly ControllerEvidenceLine[],
): string =>
  lines
    .map((line) =>
      [
        `check: ${line.id}`,
        `command: ${line.command}`,
        `status: ${line.status}`,
        `exit: ${line.exitCode === undefined ? "n/a" : String(line.exitCode)}`,
        `output: ${line.output || "(none)"}`,
      ].join("\n"),
    )
    .join("\n\n");

export type ControllerVerificationOutcome =
  /** The candidate is verified and the turn may advance. */
  | { outcome: "advance" }
  /** The same agent gets another turn to repair what failed. */
  | { outcome: "revise"; attempt: number }
  /** Nothing more will be attempted here: the run cannot advance on this evidence. */
  | { outcome: "blocked" };

/**
 * What happens to a turn whose declared checks are not passing.
 *
 * A Worker repairs its own work: it is given another turn, with the exact failures, until the
 * revision budget it was configured with is used up. A Lead never repairs anything — it reviews —
 * so a Lead facing failing checks does not retry, it declines to approve and the run goes back to
 * the Worker through the pipeline's existing revision route.
 *
 * A budget of zero means no repair attempt at all, not an unbounded one.
 */
export const controllerVerificationOutcome = (input: {
  role: string;
  authorized: boolean;
  attemptsUsed: number;
  maxRevisionCycles: number;
}): ControllerVerificationOutcome => {
  if (input.authorized) return { outcome: "advance" };
  if (input.role !== "worker") return { outcome: "blocked" };
  const budget = Math.max(0, Math.trunc(input.maxRevisionCycles));
  return input.attemptsUsed < budget
    ? { outcome: "revise", attempt: input.attemptsUsed + 1 }
    : { outcome: "blocked" };
};

/**
 * What the agent is told when its declared checks are not passing.
 *
 * The failures are named by id and repeated as exact evidence, so the turn is answering the
 * controller's own result rather than a description of it.
 */
export const controllerVerificationPrompt = (input: {
  role: string;
  issues: readonly string[];
  evidence: readonly ControllerEvidenceLine[];
}): string =>
  [
    "Bachata ran the controller-owned verification this pipeline declares, and it is not passing.",
    `Required verification: ${input.issues.join(", ")}`,
    renderControllerVerificationEvidence(input.evidence),
    input.role === "worker"
      ? "Repair the implementation so every declared check passes. Return your revised work; Bachata runs the checks again itself."
      : "Do not approve this candidate. Return objections naming what must change, or block the task.",
  ].join("\n\n");
