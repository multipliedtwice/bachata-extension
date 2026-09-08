import { createHash } from "node:crypto";

export type PlanStep = {
  id: string;
  intent: string;
  files: string[];
  verification?: string;
};

export type InitiativePlanCandidate = {
  title: string;
  summary: string;
  scope: string[];
  steps: PlanStep[];
  risks: string[];
  acceptanceCriteria: string[];
  evidence: string[];
};

export type PlanSource = {
  stepId: string;
  participantIds: string[];
  plan: InitiativePlanCandidate;
};

export type PlanSourceResult = {
  source?: PlanSource;
  errors: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const textList = (value: unknown): string[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const item of value) {
    const parsed = text(item);
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return Array.from(new Set(values));
};

const parseStep = (value: unknown): PlanStep | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const intent = text(value.intent);
  const files = textList(value.files);
  const verification = value.verification === undefined
    ? undefined
    : text(value.verification);
  if (
    id === undefined || intent === undefined || files === undefined ||
    (value.verification !== undefined && verification === undefined)
  ) return undefined;
  return {
    id,
    intent,
    files,
    ...(verification === undefined ? {} : { verification }),
  };
};

export const parseInitiativePlanCandidate = (
  value: unknown,
): InitiativePlanCandidate | undefined => {
  if (!isRecord(value)) return undefined;
  const title = text(value.title);
  const summary = text(value.summary);
  const scope = textList(value.scope);
  const risks = textList(value.risks);
  const acceptanceCriteria = textList(value.acceptanceCriteria);
  const evidence = textList(value.evidence);
  if (
    title === undefined || summary === undefined || scope === undefined ||
    risks === undefined || acceptanceCriteria === undefined || evidence === undefined ||
    !Array.isArray(value.steps) || value.steps.length === 0
  ) return undefined;
  const steps: PlanStep[] = [];
  const ids = new Set<string>();
  for (const item of value.steps) {
    const step = parseStep(item);
    if (step === undefined) return undefined;
    const key = step.id.trim().toLowerCase();
    if (ids.has(key)) return undefined;
    ids.add(key);
    steps.push(step);
  }
  return { title, summary, scope, steps, risks, acceptanceCriteria, evidence };
};

export const validateInitiativePlanCandidate = (
  value: unknown,
): { plan?: InitiativePlanCandidate; errors: string[] } => {
  if (!isRecord(value)) return { errors: ["The plan candidate is not a plan object"] };
  const errors: string[] = [];
  if (text(value.title) === undefined) errors.push("The plan has no title");
  if (text(value.summary) === undefined) errors.push("The plan has no summary");
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    errors.push("The plan has no steps");
  } else {
    const ids = new Set<string>();
    value.steps.forEach((item, index) => {
      const step = parseStep(item);
      if (step === undefined) {
        errors.push(`Plan step ${String(index + 1)} is malformed`);
        return;
      }
      const key = step.id.trim().toLowerCase();
      if (ids.has(key)) errors.push(`The plan repeats the step id ${step.id}`);
      ids.add(key);
    });
  }
  for (const field of ["scope", "risks", "acceptanceCriteria", "evidence"] as const) {
    if (value[field] !== undefined && textList(value[field]) === undefined) {
      errors.push(`The plan has a malformed ${field} list`);
    }
  }
  const plan = parseInitiativePlanCandidate(value);
  if (plan === undefined && errors.length === 0) {
    errors.push("The plan candidate could not be read as a plan");
  }
  return plan === undefined || errors.length > 0 ? { errors } : { plan, errors };
};

export const planContentDigest = (plan: InitiativePlanCandidate): string =>
  createHash("sha256")
    .update(JSON.stringify({
      title: plan.title.toLowerCase(),
      summary: plan.summary.toLowerCase(),
      scope: [...plan.scope].sort(),
      steps: plan.steps.map((step) => ({
        id: step.id.toLowerCase(),
        intent: step.intent.toLowerCase(),
        files: [...step.files].sort(),
        verification: step.verification?.toLowerCase() ?? null,
      })),
      risks: [...plan.risks].sort(),
      acceptanceCriteria: [...plan.acceptanceCriteria].sort(),
      evidence: [...plan.evidence].sort(),
    }))
    .digest("hex")
    .slice(0, 40)
    .toUpperCase();

export const planArtifactBody = (plan: InitiativePlanCandidate): string => [
  plan.summary,
  ...(plan.scope.length === 0 ? [] : ["", `Scope: ${plan.scope.join("; ")}`]),
  "",
  "Steps:",
  ...plan.steps.flatMap((step) => [
    `${step.id}. ${step.intent}`,
    ...(step.files.length === 0 ? [] : [`  files: ${step.files.join(", ")}`]),
    ...(step.verification === undefined ? [] : [`  verification: ${step.verification}`]),
  ]),
  ...(plan.acceptanceCriteria.length === 0
    ? []
    : ["", "Acceptance criteria:", ...plan.acceptanceCriteria.map((item) => `- ${item}`)]),
  ...(plan.risks.length === 0
    ? []
    : ["", "Risks:", ...plan.risks.map((item) => `- ${item}`)]),
].join("\n");

export const planSourceFromDecisionArtifact = (value: unknown): PlanSourceResult => {
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
    candidate === undefined ||
    !Array.isArray(candidate.steps)
  ) return { errors: [] };
  const validated = validateInitiativePlanCandidate(candidate);
  if (validated.plan === undefined) return { errors: validated.errors };
  return { source: { stepId, participantIds, plan: validated.plan }, errors: [] };
};
