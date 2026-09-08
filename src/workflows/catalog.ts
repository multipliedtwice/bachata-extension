export const setupVersion = 1;

export type WorkflowGoalId =
  | "review"
  | "productReview"
  | "plan"
  | "featureDelivery"
  | "fix"
  | "todo"
  | "browser"
  | "custom";

export type WorkflowMode = "single" | "paired";

export const workflowModeLabels: Record<WorkflowMode, string> = {
  single: "Fast single agent",
  paired: "Cross-checked pair",
};

export type WorkflowCard = {
  id: WorkflowGoalId;
  title: string;
  detail: string;
  pipelineIds: string[];
  modePipelineIds?: Record<WorkflowMode, string[]>;
  advanced?: boolean;
};

export type WorkflowModeState = {
  mode: WorkflowMode;
  label: string;
  status: ReadinessStatus;
  pipelineId?: string;
  readinessDetail: string;
};

export type SetupState = {
  version: number;
  completed: boolean;
  goalId?: WorkflowGoalId;
  pipelineId?: string;
  conversationId?: string;
  updatedAt: string;
};

export type WorkflowCardState = WorkflowCard & {
  status: ReadinessStatus;
  pipelineId?: string;
  readinessDetail: string;
  modes: WorkflowModeState[];
};

const goalCard = (
  id: WorkflowGoalId,
  title: string,
  detail: string,
  single: string[],
  paired: string[],
): WorkflowCard => ({
  id,
  title,
  detail,
  pipelineIds: [...single, ...paired],
  modePipelineIds: { single, paired },
});

export const workflowCards = (): WorkflowCard[] => [
  goalCard("review", "Review code", "Read-only evidence-backed review", ["codex-review", "claude-review"], ["review-only"]),
  {
    id: "productReview",
    title: "Review the product",
    detail: "Cross-checked recommendations with explicit dispositions, recorded as artifacts",
    pipelineIds: ["product-review"],
  },
  goalCard("plan", "Plan a change", "A bounded implementation plan, no files changed", ["codex-plan", "claude-plan"], ["plan"]),
  {
    id: "featureDelivery",
    title: "Deliver a feature",
    detail: "Agreed requirements and design, then a managed implementation a Lead reviews",
    pipelineIds: ["feature-delivery"],
  },
  goalCard("fix", "Fix a bug", "Diagnosis and implementation inside a declared write scope", ["managed-fix", "codex-fix", "claude-fix"], ["paired-managed-fix", "debug"]),
  { id: "todo", title: "Run TODO.md", detail: "Managed task orchestration", pipelineIds: ["todo-master"], advanced: true },
  { id: "browser", title: "Browser pair", detail: "Paired local browser sessions", pipelineIds: ["browser-pair", "claude-browser-pair"], advanced: true },
  { id: "custom", title: "Custom pipelines", detail: "The full pipeline catalog", pipelineIds: [], advanced: true },
];

export const defaultJourneyCards = (cards: WorkflowCard[]): WorkflowCard[] =>
  cards.filter((card) => !card.advanced);

export const advancedCards = (cards: WorkflowCard[]): WorkflowCard[] =>
  cards.filter((card) => card.advanced === true);

const readinessRank: Record<ReadinessStatus, number> = {
  ready: 0,
  needsSetup: 1,
  blocked: 2,
  unsupported: 3,
};

export type WorkflowProviderSelection = {
  pipelineProviders?: Readonly<Record<string, readonly string[]>>;
  preferredProvider?: string;
};

// A stated provider preference outranks readiness, so a human who named a provider is never
// silently given a workflow backed by a different one.
const preferenceRank = (
  pipelineId: string | undefined,
  selection: WorkflowProviderSelection,
): number => {
  const preferred = selection.preferredProvider;
  if (!preferred || preferred === "auto" || pipelineId === undefined) return 0;
  return selection.pipelineProviders?.[pipelineId]?.includes(preferred) ? 0 : 1;
};

const bestCandidate = (
  pipelineIds: string[],
  readiness: PipelineReadiness[],
  selection: WorkflowProviderSelection = {},
): PipelineReadiness | undefined => pipelineIds
  .map((pipelineId) => readiness.find((item) => item.pipelineId === pipelineId))
  .filter((item): item is PipelineReadiness => item !== undefined)
  .sort((left, right) =>
    preferenceRank(left.pipelineId, selection) - preferenceRank(right.pipelineId, selection)
    || readinessRank[left.status] - readinessRank[right.status])[0];

const describeCandidate = (
  candidate: PipelineReadiness | undefined,
  pipelineNames: Readonly<Record<string, string>>,
): { status: ReadinessStatus; pipelineId?: string; readinessDetail: string } => {
  if (!candidate?.pipelineId) {
    return { status: "blocked", readinessDetail: "No matching built-in pipeline is available" };
  }
  const pipelineName = pipelineNames[candidate.pipelineId] ?? candidate.pipelineId;
  if (candidate.status === "ready") {
    return { status: "ready", pipelineId: candidate.pipelineId, readinessDetail: pipelineName };
  }
  const cause = candidate.findings.find((finding) => finding.status !== "ready")?.detail
    ?? "Run Doctor for details";
  return {
    status: candidate.status,
    pipelineId: candidate.pipelineId,
    readinessDetail: `${pipelineName}: ${cause}`,
  };
};

const modeOrder: WorkflowMode[] = ["paired", "single"];

export const resolveWorkflowCards = (
  cards: WorkflowCard[],
  readiness: PipelineReadiness[],
  pipelineNames: Readonly<Record<string, string>> = {},
  overrides: Partial<Record<WorkflowGoalId, PipelineReadiness>> = {},
  selection: WorkflowProviderSelection = {},
): WorkflowCardState[] => cards.map((card) => {
  if (card.pipelineIds.length === 0) {
    return {
      ...card,
      status: "needsSetup",
      readinessDetail: "Open the full pipeline catalog",
      modes: [],
    };
  }
  const override = overrides[card.id];
  if (override) {
    const blocker = override.findings.find((item) => item.status !== "ready");
    return {
      ...card,
      status: override.status,
      ...(override.pipelineId === undefined ? {} : { pipelineId: override.pipelineId }),
      readinessDetail: blocker
        ? blocker.detail
        : pipelineNames[override.pipelineId ?? ""] ?? override.pipelineId ?? card.title,
      modes: [],
    };
  }
  const modePipelineIds = card.modePipelineIds;
  if (!modePipelineIds) {
    return {
      ...card,
      ...describeCandidate(bestCandidate(card.pipelineIds, readiness, selection), pipelineNames),
      modes: [],
    };
  }
  const modes: WorkflowModeState[] = modeOrder.map((mode) => ({
    mode,
    label: workflowModeLabels[mode],
    ...describeCandidate(bestCandidate(modePipelineIds[mode], readiness, selection), pipelineNames),
  }));
  const preferred = modes.slice().sort((left, right) =>
    readinessRank[left.status] - readinessRank[right.status])[0];
  return {
    ...card,
    status: preferred?.status ?? "blocked",
    ...(preferred?.pipelineId === undefined ? {} : { pipelineId: preferred.pipelineId }),
    readinessDetail: preferred?.readinessDetail ?? "No matching built-in pipeline is available",
    modes,
  };
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const parseGoalId = (value: unknown): WorkflowGoalId | undefined => {
  if (
    value === "review" || value === "productReview" || value === "plan"
    || value === "featureDelivery" || value === "fix" || value === "todo"
    || value === "browser" || value === "custom"
  ) return value;
  return undefined;
};

export const parseSetupState = (value: unknown): SetupState | undefined => {
  if (!isRecord(value)) return undefined;
  const candidate = value;
  if (candidate.version !== setupVersion || typeof candidate.completed !== "boolean" || typeof candidate.updatedAt !== "string") return undefined;
  const goalId = parseGoalId(candidate.goalId);
  return {
    version: setupVersion,
    completed: candidate.completed,
    ...(goalId === undefined ? {} : { goalId }),
    ...(typeof candidate.pipelineId === "string" ? { pipelineId: candidate.pipelineId } : {}),
    ...(typeof candidate.conversationId === "string"
      ? { conversationId: candidate.conversationId }
      : {}),
    updatedAt: candidate.updatedAt,
  };
};

export const completeSetup = (
  goalId: WorkflowGoalId,
  pipelineId?: string,
  now = new Date(),
  conversationId?: string,
): SetupState => ({
  version: setupVersion,
  completed: true,
  goalId,
  ...(pipelineId === undefined ? {} : { pipelineId }),
  ...(conversationId === undefined ? {} : { conversationId }),
  updatedAt: now.toISOString(),
});

export const pendingSetup = (
  goalId: WorkflowGoalId,
  pipelineId?: string,
  now = new Date(),
): SetupState => ({
  version: setupVersion,
  completed: false,
  goalId,
  ...(pipelineId === undefined ? {} : { pipelineId }),
  updatedAt: now.toISOString(),
});

export const resumableSetup = (
  state: SetupState | undefined,
  cards: WorkflowCard[],
): { goalId: WorkflowGoalId; title: string; pipelineId?: string } | undefined => {
  if (!state || state.completed || state.goalId === undefined) return undefined;
  const card = cards.find((candidate) => candidate.id === state.goalId);
  if (!card) return undefined;
  return {
    goalId: card.id,
    title: card.title,
    ...(state.pipelineId === undefined ? {} : { pipelineId: state.pipelineId }),
  };
};
import type { PipelineReadiness, ReadinessStatus } from "../readiness/model";
