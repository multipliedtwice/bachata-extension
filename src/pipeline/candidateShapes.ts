import { JsonOutputSchema } from "./types";

const LOCATION_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["file"],
  additionalProperties: false,
  properties: {
    file: { type: "string", minLength: 1 },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
  },
};

const STRING_LIST_SCHEMA: JsonOutputSchema = {
  type: "array",
  items: { type: "string", minLength: 1 },
};

const findingSchema = (dispositions: string[]): JsonOutputSchema => ({
  type: "object",
  required: ["id", "subject", "message", "disposition", "evidence", "challenges"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    subject: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
    disposition: { type: "string", enum: dispositions },
    severity: { type: "string", enum: ["error", "warning", "information"] },
    evidence: STRING_LIST_SCHEMA,
    challenges: STRING_LIST_SCHEMA,
    location: LOCATION_SCHEMA,
  },
});

const findingSetSchema = (dispositions: string[]): JsonOutputSchema => ({
  type: "object",
  required: ["findings"],
  additionalProperties: false,
  properties: {
    findings: { type: "array", items: findingSchema(dispositions) },
  },
});

export const PROPOSED_FINDING_SET_SCHEMA = findingSetSchema(["proposed"]);

export const RULED_FINDING_SET_SCHEMA = findingSetSchema([
  "accepted",
  "rejected",
  "unresolved",
]);

const DECISION_OPTION_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["id", "summary", "tradeOffs"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    tradeOffs: STRING_LIST_SCHEMA,
  },
};

export const LONGITUDINAL_DECISION_SET_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["decisions"],
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        required: ["subject", "question", "affectedScope", "evidence"],
        additionalProperties: false,
        properties: {
          subject: { type: "string", minLength: 1 },
          question: { type: "string", minLength: 1 },
          affectedScope: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          options: { type: "array", items: DECISION_OPTION_SCHEMA },
          tradeOffs: STRING_LIST_SCHEMA,
          recommendation: { type: "string", minLength: 1 },
          evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          supersedes: {
            type: "object",
            required: ["subject", "affectedScope"],
            additionalProperties: false,
            properties: {
              subject: { type: "string", minLength: 1 },
              affectedScope: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            },
          },
        },
      },
    },
  },
};

export const INITIATIVE_PLAN_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["title", "summary", "steps"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    scope: STRING_LIST_SCHEMA,
    risks: STRING_LIST_SCHEMA,
    acceptanceCriteria: STRING_LIST_SCHEMA,
    evidence: STRING_LIST_SCHEMA,
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "intent"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          intent: { type: "string", minLength: 1 },
          files: STRING_LIST_SCHEMA,
          verification: { type: "string", minLength: 1 },
        },
      },
    },
  },
};


const dispositionedItemSchema = (
  required: string[],
  properties: Record<string, JsonOutputSchema>,
): JsonOutputSchema => ({
  type: "object",
  required: ["id", "disposition", "evidence", "challenges", ...required],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    disposition: { type: "string", enum: ["accepted", "rejected", "unresolved"] },
    evidence: STRING_LIST_SCHEMA,
    challenges: STRING_LIST_SCHEMA,
    affectedScope: STRING_LIST_SCHEMA,
    ...properties,
  },
});

export const PRODUCT_RECOMMENDATION_SET_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["recommendations"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    evidence: STRING_LIST_SCHEMA,
    recommendations: {
      type: "array",
      items: dispositionedItemSchema(["subject", "statement", "rationale"], {
        subject: { type: "string", minLength: 1 },
        statement: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
        impact: { type: "string", enum: ["high", "medium", "low"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      }),
    },
  },
};

export const FEATURE_REQUIREMENT_SET_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["requirements"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    evidence: STRING_LIST_SCHEMA,
    requirements: {
      type: "array",
      items: dispositionedItemSchema(["statement", "acceptanceCriteria"], {
        statement: { type: "string", minLength: 1 },
        acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        priority: { type: "string", enum: ["must", "should", "could"] },
        outOfScope: STRING_LIST_SCHEMA,
      }),
    },
  },
};

const REPOSITORY_EVIDENCE_SCHEMA: JsonOutputSchema = {
  type: "array",
  minItems: 1,
  maxItems: 20,
  items: { type: "string", minLength: 1 },
};

export const SELF_IMPROVEMENT_TASK_PLAN_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["title", "summary", "tasks"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    evidence: STRING_LIST_SCHEMA,
    blockers: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["subject", "question", "evidence"],
        additionalProperties: false,
        properties: {
          subject: { type: "string", minLength: 1 },
          question: { type: "string", minLength: 1 },
          evidence: REPOSITORY_EVIDENCE_SCHEMA,
        },
      },
    },
    tasks: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["id", "outcome", "details", "paths", "checks", "evidence"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          outcome: { type: "string", minLength: 1 },
          details: { type: "string", minLength: 1 },
          paths: { type: "array", minItems: 1, maxItems: 40, items: { type: "string", minLength: 1 } },
          dependsOn: { type: "array", maxItems: 20, items: { type: "string", minLength: 1 } },
          checks: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 } },
          finalChecks: { type: "array", maxItems: 10, items: { type: "string", minLength: 1 } },
          priority: { type: "integer", minimum: 0, maximum: 1000 },
          retries: { type: "integer", minimum: 0, maximum: 10 },
          evidence: REPOSITORY_EVIDENCE_SCHEMA,
        },
      },
    },
  },
};

/*
 * A first-pass audit says what it read before it says what it found. An agent that could not
 * read the candidate reports that instead of returning an empty finding list, so a transport
 * that completed cannot be mistaken for an audit that happened.
 */
export const REPOSITORY_AUDIT_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["status", "inspected", "findings"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["assessed", "blocked"] },
    // Empty when the audit was not blocked; the gate requires a reason only when it was.
    blockedReason: { type: "string" },
    inspected: { type: "array", maxItems: 200, items: { type: "string", minLength: 1 } },
    findings: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        required: ["subject", "statement", "evidence"],
        additionalProperties: false,
        properties: {
          subject: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          proposedChange: { type: "string", minLength: 1 },
          verification: { type: "string", minLength: 1 },
          evidence: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
};

export const TASK_REVIEW_VERDICT_SCHEMA: JsonOutputSchema = {
  type: "object",
  required: ["verdict", "summary", "defects"],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["accept", "reject"] },
    summary: { type: "string", minLength: 1 },
    defects: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: ["id", "statement", "requiredChange", "evidence"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          statement: { type: "string", minLength: 1 },
          requiredChange: { type: "string", minLength: 1 },
          evidence: { type: "array", maxItems: 20, items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
};

const SHAPES: Record<string, JsonOutputSchema> = {
  proposedModelFindingSet: PROPOSED_FINDING_SET_SCHEMA,
  ruledModelFindingSet: RULED_FINDING_SET_SCHEMA,
  longitudinalDecisionSet: LONGITUDINAL_DECISION_SET_SCHEMA,
  initiativePlan: INITIATIVE_PLAN_SCHEMA,
  productRecommendationSet: PRODUCT_RECOMMENDATION_SET_SCHEMA,
  featureRequirementSet: FEATURE_REQUIREMENT_SET_SCHEMA,
  selfImprovementTaskPlan: SELF_IMPROVEMENT_TASK_PLAN_SCHEMA,
  taskReviewVerdict: TASK_REVIEW_VERDICT_SCHEMA,
  repositoryAudit: REPOSITORY_AUDIT_SCHEMA,
};

export const CANDIDATE_SHAPE_NAMES = Object.keys(SHAPES);

export const resolveCandidateShape = (
  name: string | undefined,
): JsonOutputSchema | undefined => (name === undefined ? undefined : SHAPES[name]);

export const isCandidateShapeName = (value: unknown): value is string =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(SHAPES, value);
