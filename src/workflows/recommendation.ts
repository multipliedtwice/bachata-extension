import type { ReadinessStatus } from "../readiness/model";

export type WorkflowShape = "singleAgent" | "paired" | "externalEvidenceHeavy";

export type WorkflowConsequence = {
  writesWorkspace: boolean;
  isolatedRetainedWork: boolean;
  openDecisions: number;
  regressions: number;
  outstandingAcceptedFindings: number;
  unresolvedExternalClaims: number;
  staleExternalClaims: number;
  contestedExternalClaims: number;
};

export type WorkflowShapeAvailability = Partial<Record<WorkflowShape, ReadinessStatus>>;

export type WorkflowRecommendation = {
  shape: WorkflowShape;
  label: string;
  reasons: string[];
  consequences: string[];
  substituted?: { preferred: WorkflowShape; because: string };
  humanChoiceRequired: true;
};

export const workflowShapeLabels: Record<WorkflowShape, string> = {
  singleAgent: "Fast single agent",
  paired: "Cross-checked pair",
  externalEvidenceHeavy: "Settle the outside claims first",
};

const consequenceStatements: Record<WorkflowShape, string[]> = {
  singleAgent: [
    "One provider answers. Nothing cross-checks it.",
    "Cheapest to run and the easiest to redo if the answer is wrong.",
  ],
  paired: [
    "Two providers answer independently and must converge before the work proceeds.",
    "Costs a second provider run, and stops for you when they do not agree.",
  ],
  externalEvidenceHeavy: [
    "The blocking claims come from outside this repository, so no amount of reading the code settles them.",
    "Record the sources, rule on them, and only then choose how to do the work.",
  ],
};

const EXTERNAL_CLAIM_THRESHOLD = 1;

// One ordered ladder, first match wins. The same consequences always produce the same
// recommendation, and the recommendation is never applied on its own: the human picks.
const preferredShape = (consequence: WorkflowConsequence): { shape: WorkflowShape; reasons: string[] } => {
  const outsideClaims = consequence.unresolvedExternalClaims
    + consequence.contestedExternalClaims
    + consequence.staleExternalClaims;
  if (outsideClaims >= EXTERNAL_CLAIM_THRESHOLD) {
    return {
      shape: "externalEvidenceHeavy",
      reasons: [
        ...(consequence.unresolvedExternalClaims > 0
          ? [`${String(consequence.unresolvedExternalClaims)} external claim${consequence.unresolvedExternalClaims === 1 ? "" : "s"} nobody has ruled on`]
          : []),
        ...(consequence.contestedExternalClaims > 0
          ? [`${String(consequence.contestedExternalClaims)} external claim${consequence.contestedExternalClaims === 1 ? "" : "s"} participants challenged`]
          : []),
        ...(consequence.staleExternalClaims > 0
          ? [`${String(consequence.staleExternalClaims)} external claim${consequence.staleExternalClaims === 1 ? "" : "s"} past its freshness horizon`]
          : []),
      ],
    };
  }
  const pairedReasons = [
    ...(consequence.writesWorkspace && !consequence.isolatedRetainedWork
      ? ["this work writes your selected workspace directly and Bachata does not roll it back"]
      : []),
    ...(consequence.writesWorkspace && consequence.isolatedRetainedWork
      ? ["this work writes to a retained worktree you apply from"]
      : []),
    ...(consequence.regressions > 0
      ? [`${String(consequence.regressions)} finding${consequence.regressions === 1 ? "" : "s"} regressed since the last round`]
      : []),
    ...(consequence.openDecisions > 0
      ? [`${String(consequence.openDecisions)} decision${consequence.openDecisions === 1 ? "" : "s"} is still open`]
      : []),
    ...(consequence.outstandingAcceptedFindings > 0
      ? [`${String(consequence.outstandingAcceptedFindings)} accepted finding${consequence.outstandingAcceptedFindings === 1 ? "" : "s"} still needs a fix`]
      : []),
  ];
  if (pairedReasons.length > 0) {
    return { shape: "paired", reasons: pairedReasons };
  }
  return {
    shape: "singleAgent",
    reasons: [
      "this work writes nothing, and nothing about it is contested or blocked on evidence from outside the repository",
    ],
  };
};

const runnable = (
  availability: WorkflowShapeAvailability,
  shape: WorkflowShape,
): boolean => availability[shape] === "ready";

const fallbackOrder: Record<WorkflowShape, WorkflowShape[]> = {
  externalEvidenceHeavy: ["paired", "singleAgent"],
  paired: ["singleAgent"],
  singleAgent: ["paired"],
};

export const recommendWorkflow = (input: {
  consequence: WorkflowConsequence;
  availability?: WorkflowShapeAvailability;
}): WorkflowRecommendation => {
  const preferred = preferredShape(input.consequence);
  const availability = input.availability;
  const substitute = availability === undefined || runnable(availability, preferred.shape)
    ? undefined
    : fallbackOrder[preferred.shape].find((shape) => runnable(availability, shape));
  const shape = substitute ?? preferred.shape;
  return {
    shape,
    label: workflowShapeLabels[shape],
    reasons: preferred.reasons,
    consequences: consequenceStatements[shape],
    ...(substitute === undefined
      ? {}
      : {
          substituted: {
            preferred: preferred.shape,
            because: `${workflowShapeLabels[preferred.shape]} is not runnable here`,
          },
        }),
    humanChoiceRequired: true,
  };
};

export const workflowRecommendationStatement = (
  recommendation: WorkflowRecommendation,
): string => [
  `Bachata suggests ${recommendation.label}`,
  recommendation.reasons.length > 0 ? `because ${recommendation.reasons.join(", and ")}` : "",
  recommendation.substituted
    ? `· ${workflowShapeLabels[recommendation.substituted.preferred]} would fit better, but ${recommendation.substituted.because}`
    : "",
  "· you choose",
].filter((part) => part.length > 0).join(" ");
