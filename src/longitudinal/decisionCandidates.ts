import { decisionLogicalIdentity, decisionMaterialDigest } from "./lifecycle";
import type { DecisionOption } from "./types";

export type DecisionPredecessorRef = {
  subject: string;
  affectedScope: string[];
};

export type LongitudinalDecisionCandidate = {
  subject: string;
  question: string;
  affectedScope: string[];
  options: DecisionOption[];
  tradeOffs: string[];
  recommendation?: string;
  evidence: string[];
  supersedes?: DecisionPredecessorRef;
};

export type LongitudinalDecisionSource = {
  stepId: string;
  participantIds: string[];
  candidates: LongitudinalDecisionCandidate[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const textList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const item of value) {
    const parsed = text(item);
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return Array.from(new Set(values));
};

const parseOption = (value: unknown): DecisionOption | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const summary = text(value.summary);
  const tradeOffs = value.tradeOffs === undefined ? [] : textList(value.tradeOffs);
  if (id === undefined || summary === undefined || tradeOffs === undefined) return undefined;
  return { id, summary, tradeOffs };
};

const parseOptions = (value: unknown): DecisionOption[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const options: DecisionOption[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const option = parseOption(item);
    if (option === undefined) return undefined;
    const key = option.id.trim().toLowerCase();
    if (ids.has(key)) return undefined;
    ids.add(key);
    options.push(option);
  }
  return options;
};

const parsePredecessor = (value: unknown): DecisionPredecessorRef | undefined | false => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  const subject = text(value.subject);
  const affectedScope = textList(value.affectedScope);
  if (subject === undefined || affectedScope === undefined || affectedScope.length === 0) {
    return false;
  }
  return { subject, affectedScope };
};

export type DecisionCandidateValidation = {
  candidate?: LongitudinalDecisionCandidate;
  errors: string[];
};

export const validateDecisionCandidate = (
  value: unknown,
  label: string,
): DecisionCandidateValidation => {
  if (!isRecord(value)) return { errors: [`${label} is not a decision object`] };
  const errors: string[] = [];
  if (text(value.subject) === undefined) errors.push(`${label} has no subject`);
  if (text(value.question) === undefined) errors.push(`${label} has no question`);
  const scope = textList(value.affectedScope);
  if (scope === undefined || scope.length === 0) {
    errors.push(`${label} has no affected scope`);
  }
  const evidence = textList(value.evidence);
  if (evidence === undefined || evidence.length === 0) {
    errors.push(`${label} has no evidence`);
  }
  if (value.tradeOffs !== undefined && textList(value.tradeOffs) === undefined) {
    errors.push(`${label} has a malformed trade-off list`);
  }
  if (value.recommendation !== undefined && text(value.recommendation) === undefined) {
    errors.push(`${label} has a malformed recommendation`);
  }
  if (parsePredecessor(value.supersedes) === false) {
    errors.push(`${label} names a malformed predecessor`);
  }
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) {
      errors.push(`${label} has a malformed option list`);
    } else {
      const ids = new Set<string>();
      value.options.forEach((item, index) => {
        const option = parseOption(item);
        if (option === undefined) {
          errors.push(`${label} option ${String(index + 1)} is malformed`);
          return;
        }
        const key = option.id.trim().toLowerCase();
        if (ids.has(key)) errors.push(`${label} repeats the option id ${option.id}`);
        ids.add(key);
      });
    }
  }
  const candidate = parseLongitudinalDecisionCandidate(value);
  if (candidate === undefined && errors.length === 0) {
    errors.push(`${label} could not be read as a decision`);
  }
  return candidate === undefined || errors.length > 0 ? { errors } : { candidate, errors };
};

export const parseLongitudinalDecisionCandidate = (
  value: unknown,
): LongitudinalDecisionCandidate | undefined => {
  if (!isRecord(value)) return undefined;
  const subject = text(value.subject);
  const question = text(value.question);
  const affectedScope = textList(value.affectedScope);
  const evidence = textList(value.evidence);
  const options = parseOptions(value.options);
  const tradeOffs = value.tradeOffs === undefined ? [] : textList(value.tradeOffs);
  const recommendation = value.recommendation === undefined
    ? undefined
    : text(value.recommendation);
  const supersedes = parsePredecessor(value.supersedes);
  if (supersedes === false) return undefined;
  if (
    subject === undefined ||
    question === undefined ||
    affectedScope === undefined ||
    affectedScope.length === 0 ||
    evidence === undefined ||
    evidence.length === 0 ||
    options === undefined ||
    tradeOffs === undefined ||
    (value.recommendation !== undefined && recommendation === undefined)
  ) return undefined;
  return {
    subject,
    question,
    affectedScope,
    options,
    tradeOffs,
    ...(recommendation === undefined ? {} : { recommendation }),
    evidence,
    ...(supersedes === undefined ? {} : { supersedes }),
  };
};

export type DecisionSourceResult = {
  source?: LongitudinalDecisionSource;
  errors: string[];
};

export const decisionSourceFromDecisionArtifact = (
  value: unknown,
): DecisionSourceResult => {
  if (!isRecord(value)) return { errors: [] };
  const stepId = text(value.stepId);
  const status = value.status;
  const participantIds = Array.isArray(value.participants)
    ? Array.from(new Set(value.participants.flatMap((participant) => {
        if (!isRecord(participant)) return [];
        const agentId = text(participant.agentId);
        return agentId === undefined ? [] : [agentId];
      })))
    : [];
  const candidate = isRecord(value.candidate) ? value.candidate : undefined;
  if (
    stepId === undefined ||
    (status !== "accepted" && status !== "ruled") ||
    participantIds.length === 0 ||
    !Array.isArray(candidate?.decisions)
  ) return { errors: [] };
  if (candidate.decisions.length === 0) return { errors: [] };
  const errors: string[] = [];
  const candidates: LongitudinalDecisionCandidate[] = [];
  candidate.decisions.forEach((item, index) => {
    const validated = validateDecisionCandidate(item, `Decision ${String(index + 1)}`);
    errors.push(...validated.errors);
    if (validated.candidate !== undefined) candidates.push(validated.candidate);
  });
  const byIdentity = new Map<string, string>();
  candidates.forEach((item, index) => {
    const identity = decisionLogicalIdentity(item.subject, item.affectedScope);
    const digest = decisionMaterialDigest(item);
    const held = byIdentity.get(identity);
    if (held !== undefined && held !== digest) {
      errors.push(
        `Decision ${String(index + 1)} conflicts with an earlier decision about the same subject and scope`,
      );
    }
    byIdentity.set(identity, digest);
  });
  if (errors.length > 0) return { errors };
  const unique = new Map<string, LongitudinalDecisionCandidate>();
  candidates.forEach((item) => {
    unique.set(decisionLogicalIdentity(item.subject, item.affectedScope), item);
  });
  return { source: { stepId, participantIds, candidates: [...unique.values()] }, errors: [] };
};
