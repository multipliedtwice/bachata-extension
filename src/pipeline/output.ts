import { createHash } from "node:crypto";

import { JsonValue } from "../adapters/types";
import {
  RulingParticipantIdentity,
  RulingProvenance,
  rulingProvenanceFrom,
} from "../results/rulingProvenance";
import { resolveCandidateShape } from "./candidateShapes";
import {
  DecisionArtifact,
  DecisionParticipantRecord,
  JsonOutputSchema,
  StepOutputArtifact,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stripFence = (value: string): string => {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return match?.[1] ?? trimmed;
};

// The outermost balanced object or array starting at `open`, ignoring braces inside strings.
const balancedSpan = (source: string, open: number): string | undefined => {
  const closing = source[open] === "{" ? "}" : "]";
  const opening = source[open];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return undefined;
};

/*
 * A model asked for JSON only will sometimes still frame it — a sentence before, a fenced block,
 * a note after. Refusing those answers throws away work that is otherwise exactly right, so the
 * JSON is extracted rather than demanded: the whole answer first, then a fenced block, then the
 * outermost balanced object or array. Nothing is repaired; a candidate that does not parse is
 * still a failure.
 */
const jsonCandidates = (value: string): string[] => {
  const candidates = [stripFence(value)];
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  const fencedBody = fenced?.[1];
  if (fencedBody !== undefined) candidates.push(fencedBody);
  const start = trimmed.search(/[{[]/u);
  if (start >= 0) {
    const span = balancedSpan(trimmed, start);
    if (span !== undefined) candidates.push(span);
  }
  return candidates;
};

export const parseJsonResponse = (value: string): JsonValue => {
  let failure: unknown;
  for (const candidate of jsonCandidates(value)) {
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure ?? new SyntaxError("The response carried no JSON");
};

export const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
};

export const jsonHash = (value: JsonValue): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const matchesType = (value: JsonValue, type: NonNullable<JsonOutputSchema["type"]>): boolean => {
  if (type === "null") {
    return value === null;
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "object") {
    return isRecord(value);
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  return typeof value === type;
};

export const validateJsonOutput = (
  value: JsonValue,
  schema: JsonOutputSchema,
  valuePath = "$",
): string[] => {
  const errors: string[] = [];
  if (schema.type && !matchesType(value, schema.type)) {
    return [`${valuePath} must be ${schema.type}`];
  }
  if (schema.enum && !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))) {
    errors.push(`${valuePath} is not an allowed value`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${valuePath} must contain at least ${String(schema.minLength)} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${valuePath} must contain at most ${String(schema.maxLength)} characters`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${valuePath} must be at least ${String(schema.minimum)}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${valuePath} must be at most ${String(schema.maximum)}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${valuePath} must contain at least ${String(schema.minItems)} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${valuePath} must contain at most ${String(schema.maxItems)} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateJsonOutput(item, schema.items as JsonOutputSchema, `${valuePath}[${String(index)}]`));
      });
    }
  }
  if (isRecord(value)) {
    const required = new Set(schema.required ?? []);
    required.forEach((key) => {
      if (!(key in value)) {
        errors.push(`${valuePath}.${key} is required`);
      }
    });
    Object.entries(value).forEach(([key, item]) => {
      const property = schema.properties?.[key];
      if (property) {
        errors.push(...validateJsonOutput(item as JsonValue, property, `${valuePath}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${valuePath}.${key} is not allowed`);
      }
    });
  }
  return errors;
};

export const parseStepOutput = (
  stepId: string,
  agentId: string,
  name: string,
  answer: string,
  schema: JsonOutputSchema,
  participant?: string,
): StepOutputArtifact => {
  try {
    const value = parseJsonResponse(answer);
    const validationErrors = validateJsonOutput(value, schema);
    return {
      stepId,
      agentId,
      ...(participant === undefined ? {} : { participant }),
      name,
      value,
      hash: jsonHash(value),
      validationErrors,
    };
  } catch (error) {
    return {
      stepId,
      agentId,
      ...(participant === undefined ? {} : { participant }),
      name,
      value: null,
      hash: jsonHash(null),
      validationErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export const decisionCandidateErrors = (
  candidate: JsonValue,
  candidateField: string,
  candidateShape: string | undefined,
): string[] => {
  const schema = resolveCandidateShape(candidateShape);
  if (schema === undefined) return [];
  return validateJsonOutput(candidate, schema, `$.${candidateField}`);
};

export const parseDecisionParticipant = (
  agentId: string,
  answer: string,
  config: {
    candidateField: string;
    acceptedField: string;
    acceptedValue: boolean;
    objectionsField?: string;
    risksField?: string;
    candidateShape?: string;
  },
): DecisionParticipantRecord => {
  try {
    const parsed = parseJsonResponse(answer);
    if (!isRecord(parsed)) {
      throw new Error("Decision response must be a JSON object");
    }
    const candidate = parsed[config.candidateField] as JsonValue | undefined;
    if (candidate === undefined) {
      throw new Error(`Decision field ${config.candidateField} is required`);
    }
    const accepted = parsed[config.acceptedField];
    if (typeof accepted !== "boolean") {
      throw new Error(`Decision field ${config.acceptedField} must be boolean`);
    }
    const candidateErrors = decisionCandidateErrors(
      candidate,
      config.candidateField,
      config.candidateShape,
    );
    if (candidateErrors.length > 0) {
      return {
        agentId,
        valid: false,
        accepted: false,
        candidate,
        candidateHash: jsonHash(candidate),
        objections: [],
        unresolvedRisks: [],
        validationErrors: candidateErrors,
      };
    }
    const candidateHash = jsonHash(candidate);
    return {
      agentId,
      valid: true,
      accepted: accepted === config.acceptedValue,
      candidate,
      candidateHash,
      objections: config.objectionsField
        ? stringList(parsed[config.objectionsField])
        : [],
      unresolvedRisks: config.risksField
        ? stringList(parsed[config.risksField])
        : [],
      validationErrors: [],
    };
  } catch (error) {
    return {
      agentId,
      valid: false,
      accepted: false,
      candidate: null,
      candidateHash: jsonHash(null),
      objections: [],
      unresolvedRisks: [],
      validationErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
};

export const decisionRulingProvenance = (input: {
  status: DecisionArtifact["status"];
  participants: DecisionParticipantRecord[];
  ruledBy?: string;
  identities?: Record<string, RulingParticipantIdentity>;
}): RulingProvenance | undefined => {
  const identityFor = (agentId: string): RulingParticipantIdentity =>
    input.identities?.[agentId] ?? { agentId };
  if (input.status === "ruled" && input.ruledBy !== undefined) {
    return rulingProvenanceFrom({
      kind: "arbiterRuling",
      participants: input.participants.map((participant) => identityFor(participant.agentId)),
      ruledBy: input.ruledBy,
    });
  }
  if (input.status !== "accepted") return undefined;
  const agreed = input.participants.filter(
    (participant) => participant.valid && participant.accepted,
  );
  return rulingProvenanceFrom({
    kind: agreed.length > 1 ? "unanimousConsensus" : "singleProvider",
    participants: agreed.map((participant) => identityFor(participant.agentId)),
  });
};

export const buildDecisionArtifact = (input: {
  stepId: string;
  round: number;
  policy: "unanimous" | "arbiter";
  participants: DecisionParticipantRecord[];
  ruledBy?: string;
  identities?: Record<string, RulingParticipantIdentity>;
}): DecisionArtifact => {
  const { stepId, round, policy, participants, ruledBy } = input;
  const accepted = participants.filter((participant) => participant.valid && participant.accepted);
  const candidateHashes = new Set(accepted.map((participant) => participant.candidateHash));
  const unanimous =
    participants.length > 0 &&
    accepted.length === participants.length &&
    candidateHashes.size === 1;
  const ruling = ruledBy
    ? participants.find((participant) => participant.agentId === ruledBy && participant.valid && participant.accepted)
    : undefined;
  const acceptedParticipant = ruling ?? (unanimous ? accepted[0] : undefined);
  const status = ruling ? "ruled" : unanimous ? "accepted" : "pending";
  const candidateHash = acceptedParticipant?.candidateHash;
  const rulingProvenance = decisionRulingProvenance({
    status,
    participants,
    ...(ruledBy === undefined ? {} : { ruledBy }),
    ...(input.identities === undefined ? {} : { identities: input.identities }),
  });
  return {
    stepId,
    round,
    policy,
    status,
    ...(candidateHash ? { candidateId: `D${candidateHash.slice(0, 16).toUpperCase()}` } : {}),
    ...(candidateHash === undefined ? {} : { candidateHash }),
    ...(acceptedParticipant?.candidate === undefined
      ? {}
      : { candidate: acceptedParticipant.candidate }),
    participants,
    objections: participants.flatMap((participant) => participant.objections.map((text) => ({
      agentId: participant.agentId,
      text,
      accepted: acceptedParticipant?.candidateHash === participant.candidateHash,
    }))),
    unresolvedRisks: Array.from(new Set(participants.flatMap((participant) => participant.unresolvedRisks))),
    ...(ruledBy === undefined ? {} : { ruledBy }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
  };
};
