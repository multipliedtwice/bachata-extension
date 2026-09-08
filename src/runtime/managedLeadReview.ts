import { JsonValue } from "../adapters/types";
import { TASK_REVIEW_VERDICT_SCHEMA } from "../pipeline/candidateShapes";
import { validateJsonOutput } from "../pipeline/output";
import { JsonOutputSchema } from "../pipeline/types";
import {
  ControllerEvidenceLine,
  renderControllerVerificationEvidence,
} from "./controllerVerification";

/**
 * P3. What a managed local Lead's answer does to the run.
 *
 * A managed Lead running on a browser adapter answers inside the managed envelope, and the
 * controller reads a state out of it. A managed Lead running on a local adapter answered in prose
 * — "The implementation is ready" — and nothing read it at all: `managedTransition` only moves a
 * run when a result carries a `managedState`, and a local turn produced one only when the
 * controller's own checks were failing. So a local Lead could object in the clearest possible
 * English and the run would advance, integrate and offer the work for Apply regardless. The
 * documented Lead-to-bounded-correction behaviour was, for a local Lead, not implemented.
 *
 * The fix is a decision contract, not prose interpretation. Nothing here reads natural language:
 * the Lead returns one JSON object, it is validated against the shape this repository already has
 * for a review verdict, and anything that is missing, malformed, self-contradictory or bound to a
 * different candidate is a refusal rather than an approval.
 *
 * The three ways to fail closed, stated rather than implied:
 *
 *   - a verdict that cannot be parsed or does not validate is not an acceptance;
 *   - a verdict that does not name the exact candidate the controller verified is not an
 *     acceptance, because it describes a tree that is not the one being advanced;
 *   - a verdict whose `verdict` and `defects` disagree — accepting while listing defects, or
 *     rejecting while listing none — states two things at once and is not an acceptance either.
 *
 * What this module does not do: it does not run checks, it does not decide whether a candidate is
 * verified, and it never turns anything the Lead said about a test into evidence. The controller's
 * own check results are the only evidence, produced by `controllerVerification` and handed to the
 * Lead before it answers; the Lead's defects are the Lead's words and are carried to the Worker
 * labelled as such.
 */

/**
 * The envelope a managed local Lead answers with.
 *
 * `review` is the repository's existing `taskReviewVerdict` shape, unchanged and reused rather
 * than restated: a second review schema would be a second definition of what a defect is. What is
 * added around it is `candidate`, the fingerprint of the tree the controller verified and showed
 * the Lead, which is what binds a verdict to a candidate instead of to a moment.
 */
export const MANAGED_LEAD_REVIEW_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["candidate", "review"],
  additionalProperties: false,
  properties: {
    candidate: { type: "string", minLength: 1 },
    review: TASK_REVIEW_VERDICT_SCHEMA,
  },
};

export type ManagedLeadDefect = {
  id: string;
  severity?: string | undefined;
  statement: string;
  requiredChange: string;
  evidence: string[];
};

export type ManagedLeadDecision =
  /** The Lead approves this candidate, and the run may leave the managed block. */
  | { decision: "accept"; summary: string }
  /** The Lead refuses this candidate and named what must change. */
  | { decision: "reject"; summary: string; defects: ManagedLeadDefect[] }
  /** Nothing usable was returned. This is never an approval. */
  | { decision: "invalid"; problems: string[] };

const isRecord = (value: JsonValue): value is Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readDefect = (value: JsonValue): ManagedLeadDefect | undefined => {
  if (!isRecord(value)) return undefined;
  const { id, severity, statement, requiredChange, evidence } = value;
  if (typeof id !== "string" || typeof statement !== "string" || typeof requiredChange !== "string") {
    return undefined;
  }
  return {
    id,
    ...(typeof severity === "string" ? { severity } : {}),
    statement,
    requiredChange,
    evidence: Array.isArray(evidence)
      ? evidence.filter((item): item is string => typeof item === "string")
      : [],
  };
};

/**
 * The Lead's answer, parsed as the contract states it rather than as a model usually writes it.
 *
 * The prompt above says "Return exactly one JSON object and nothing else", and this used to be
 * read with the shared `parseJsonResponse`. That parser exists to be forgiving on purpose: it
 * strips a Markdown fence, and failing that it searches for the outermost balanced object or array
 * anywhere in the answer and parses that. It is the right parser for a step whose output is a
 * work product, where throwing away an otherwise correct answer because the model framed it costs
 * real work.
 *
 * It is the wrong parser here, because here the answer is an authorization. Under it, all of these
 * authorized a candidate:
 *
 *   - `Here is my verdict: {...}` — prose the controller never read, around a verdict it obeyed;
 *   - a fenced block, and a fenced block with commentary after it;
 *   - `{...} and I will fix the rest later` — a stated reservation, silently discarded;
 *   - two objects, of which the extractable one happened to accept.
 *
 * Each is a different thing the Lead may have meant, and the difference between them is exactly
 * what the extraction throws away. A verdict is not improved by being guessed at, so the framing
 * that would be recovered elsewhere is refused here: one JSON document, whitespace around it, and
 * nothing else. `JSON.parse` is that rule already — it rejects a prefix, a suffix, a fence and a
 * second document — so the strictness is in refusing to reach for anything more forgiving, and
 * this deliberately does not call the shared parser.
 *
 * The shared parser is left exactly as it is: other steps depend on its tolerance, and a second
 * definition of "the JSON in this answer" for them would be a regression, not a fix.
 */
const strictVerdictJson = (answer: string): JsonValue => JSON.parse(answer);

/**
 * The Lead's answer, read as a decision.
 *
 * `candidate` is what the controller verified and showed the Lead; `currentCandidate` is what the
 * tree fingerprints as now that the Lead has finished. They differ only if the tree changed while
 * the Lead was reviewing it — a Lead that edited files, or a concurrent write — and a verdict
 * about a tree that no longer exists cannot approve the tree that does.
 */
export const managedLeadDecision = (input: {
  answer: string;
  candidate: string;
  currentCandidate: string;
}): ManagedLeadDecision => {
  if (input.currentCandidate !== input.candidate) {
    return {
      decision: "invalid",
      problems: [
        `the candidate changed while the Lead was reviewing it: verified ${input.candidate}, now ${input.currentCandidate}`,
      ],
    };
  }
  let parsed: JsonValue;
  try {
    parsed = strictVerdictJson(input.answer);
  } catch (error) {
    return {
      decision: "invalid",
      problems: [
        `the Lead returned no review verdict: the contract is exactly one JSON object and nothing else, and this answer is not one (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }
  const schemaErrors = validateJsonOutput(parsed, MANAGED_LEAD_REVIEW_SCHEMA);
  if (schemaErrors.length > 0) return { decision: "invalid", problems: schemaErrors };
  // The schema has already established the shape; this narrows it for reading.
  if (!isRecord(parsed)) return { decision: "invalid", problems: ["$ must be object"] };
  const candidate = parsed.candidate;
  const review = parsed.review;
  if (typeof candidate !== "string" || review === undefined || !isRecord(review)) {
    return { decision: "invalid", problems: ["$ must carry a candidate and a review"] };
  }
  if (candidate !== input.candidate) {
    return {
      decision: "invalid",
      problems: [`the verdict names candidate ${candidate}, and the controller verified ${input.candidate}`],
    };
  }
  const verdict = review.verdict;
  const summary = typeof review.summary === "string" ? review.summary : "";
  const rawDefects: JsonValue[] = Array.isArray(review.defects) ? review.defects : [];
  const defects = rawDefects.map((entry) => readDefect(entry));
  if (defects.some((defect) => defect === undefined)) {
    return { decision: "invalid", problems: ["a defect is missing its statement or required change"] };
  }
  const named = defects.filter((defect): defect is ManagedLeadDefect => defect !== undefined);
  if (verdict === "accept") {
    return named.length === 0
      ? { decision: "accept", summary }
      : {
          decision: "invalid",
          problems: [`the verdict accepts the candidate and lists ${String(named.length)} defect(s)`],
        };
  }
  if (verdict === "reject") {
    return named.length > 0
      ? { decision: "reject", summary, defects: named }
      : { decision: "invalid", problems: ["the verdict rejects the candidate and names no defect to repair"] };
  }
  return {
    decision: "invalid",
    problems: [`the verdict is ${JSON.stringify(verdict ?? null)}, which is neither accept nor reject`],
  };
};

/** The marker the controller's own block to the Lead begins with, so a test can find it exactly. */
export const MANAGED_LEAD_REVIEW_MARKER = "Bachata managed review contract.";

/**
 * What the controller tells a managed local Lead before it answers.
 *
 * The evidence is the controller's own, per check and exact, and the candidate fingerprint is the
 * tree those results were produced against. The contract is stated as a shape rather than as an
 * instruction to be helpful: a Lead that answers in prose has not answered.
 */
export const managedLeadReviewPrompt = (input: {
  candidate: string;
  issues: readonly string[];
  evidence: readonly ControllerEvidenceLine[];
}): string =>
  [
    MANAGED_LEAD_REVIEW_MARKER,
    "Bachata controller verification (authoritative, run by the controller against this candidate):",
    renderControllerVerificationEvidence(input.evidence),
    input.issues.length > 0
      ? `Required verification: ${input.issues.join(", ")}`
      : "Required verification: every declared check is passing.",
    `Candidate: ${input.candidate}`,
    [
      "Return exactly one JSON object and nothing else. Do not edit files. Do not run checks: the",
      "results above are the controller's own and are the only evidence this run accepts.",
      "",
      "{",
      `  "candidate": "${input.candidate}",`,
      '  "review": {',
      '    "verdict": "accept" | "reject",',
      '    "summary": "one sentence",',
      '    "defects": [',
      '      { "id": "short-id", "severity": "blocker" | "major" | "minor",',
      '        "statement": "what is wrong", "requiredChange": "what must change",',
      '        "evidence": ["file:line or a quoted line"] }',
      "    ]",
      "  }",
      "}",
      "",
      "`accept` must carry an empty `defects` list. `reject` must carry at least one defect, each",
      "naming a change a Worker can make. At most ten. Anything else is refused and the task fails.",
    ].join("\n"),
  ].join("\n\n");

/** The marker the controller's own block to a revising Worker begins with. */
export const MANAGED_WORKER_REVISION_MARKER = "Bachata managed revision, requested by the Lead.";

/**
 * What the controller tells a Worker that the Lead sent work back to.
 *
 * Two sources, kept apart on purpose. The defects are the Lead's own words, attributed to the
 * Lead. The check results are the controller's, produced by running the declared checks against
 * the candidate the Lead reviewed. A Worker that conflated the two could treat a Lead's claim
 * about a test as a test result, and nothing downstream would be able to tell.
 */
export const managedWorkerRevisionPrompt = (input: {
  candidate: string;
  summary: string;
  defects: readonly ManagedLeadDefect[];
  evidence: readonly ControllerEvidenceLine[];
}): string =>
  [
    MANAGED_WORKER_REVISION_MARKER,
    `The Lead reviewed candidate ${input.candidate} and did not accept it${input.summary ? `: ${input.summary}` : "."}`,
    ["Defects the Lead named (the Lead's own words, not a check result):", ...input.defects.map((defect, index) =>
      [
        `${String(index + 1)}. [${defect.id}]${defect.severity ? ` (${defect.severity})` : ""} ${defect.statement}`,
        `   required change: ${defect.requiredChange}`,
        ...(defect.evidence.length > 0 ? [`   evidence cited: ${defect.evidence.join("; ")}`] : []),
      ].join("\n"),
    )].join("\n"),
    "Bachata controller verification against that same candidate (authoritative, run by the controller):",
    renderControllerVerificationEvidence(input.evidence),
    "Repair the implementation in the current worktree. Bachata runs every declared check again itself and the Lead reviews the result; do not report check results of your own.",
  ].join("\n\n");
