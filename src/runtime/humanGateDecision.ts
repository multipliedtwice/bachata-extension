import type { HumanGateAction, HumanGateDecision, PipelineIntervention } from "../pipeline/runner";
import type { PendingHumanGate } from "../webview/protocol";

/**
 * EX-3. What a human gate decision is allowed to be, apart from delivering it.
 *
 * A gate decision arrives from the panel and resolves a promise the pipeline is waiting on. Between
 * the two sat the guards: whether a gate is waiting at all, whether direct agent traffic must finish
 * first, whether the action is one this gate offers, whether a rollback names a real target, and
 * whether continuing past corrections needs the person's consent. Each was reachable only by
 * driving a pipeline to a gate and answering it.
 */
export const humanGateDecisionRefusal = (input: {
  waiting: boolean;
  busy: boolean;
  pendingGate: Pick<PendingHumanGate, "allowedActions" | "rollbackTargets"> | undefined;
  action: HumanGateAction;
  targetStepId?: string | undefined;
}): string | undefined => {
  if (!input.waiting) return "No human gate is waiting";
  if (input.busy) return "Wait for direct agent messages to finish before continuing";
  if (!input.pendingGate?.allowedActions.includes(input.action)) {
    return `${input.action} is not available for the current human gate`;
  }
  if (
    input.action === "rollback" &&
    (!input.targetStepId ||
      !input.pendingGate.rollbackTargets.some((target) => target.id === input.targetStepId))
  ) {
    return "Select a valid rollback target";
  }
  return undefined;
};

/**
 * Continuing past corrections the person sent after the step accepts them without the configured
 * review step rerunning, so it is asked about first. Every other action, and a continue with
 * nothing sent, needs no consent.
 */
export const continueNeedsInterventionConsent = (input: {
  action: HumanGateAction;
  interventionCount: number;
}): boolean => input.action === "continue" && input.interventionCount > 0;

export const INTERVENTION_CONSENT: { message: string; confirm: string } = {
  message:
    "Corrections were sent after this step. Continuing accepts them without rerunning the configured review step.",
  confirm: "Continue anyway",
};

/** What the ledger records for the decision: the gate it answered and the corrections it carried. */
export const gateDecidedRecord = (input: {
  pendingGate: Pick<PendingHumanGate, "stepId" | "stepName" | "reason">;
  action: HumanGateAction;
  targetStepId?: string | undefined;
  interventionIds: readonly string[];
}): {
  text: string;
  step: string;
  payload: {
    stepId: string;
    reason: PendingHumanGate["reason"];
    action: HumanGateAction;
    targetStepId: string | null;
    interventionIds: string[];
  };
} => ({
  text: `Human gate decision: ${input.action}`,
  step: input.pendingGate.stepName,
  payload: {
    stepId: input.pendingGate.stepId,
    reason: input.pendingGate.reason,
    action: input.action,
    targetStepId: input.targetStepId ?? null,
    interventionIds: [...input.interventionIds],
  },
});

/** The decision as the pipeline receives it: no target key unless a target was chosen. */
export const humanGateResolution = (input: {
  action: HumanGateAction;
  targetStepId?: string | undefined;
  interventions: PipelineIntervention[];
}): HumanGateDecision => ({
  action: input.action,
  ...(input.targetStepId === undefined ? {} : { targetStepId: input.targetStepId }),
  interventions: input.interventions,
});

/**
 * Opening a gate, decided apart from waiting on it.
 *
 * The gate the panel is shown, the question a broker is asked, and the decision read back from a
 * broker's answer were spelled out inline twice over — once for the broker path, once for the
 * panel path — so a change to one drifted from the other. The rollback targets are offered as
 * `rollback:<step>` options; a selection nobody offered is a cancel, never an action.
 */
export type HumanGateRequestLike = {
  step: { id: string; name: string };
  reason: PendingHumanGate["reason"];
  round?: number | undefined;
  detail?: string | undefined;
  allowedActions: HumanGateAction[];
  rollbackTargets: { id: string; name: string }[];
};

export const pendingGateFrom = (request: HumanGateRequestLike): PendingHumanGate => ({
  stepId: request.step.id,
  stepName: request.step.name,
  reason: request.reason,
  ...(request.round === undefined ? {} : { round: request.round }),
  ...(request.detail === undefined ? {} : { detail: request.detail }),
  allowedActions: request.allowedActions,
  rollbackTargets: request.rollbackTargets,
});

export const ROLLBACK_OPTION_PREFIX = "rollback:";

export const humanGateInteractionAsk = (
  request: HumanGateRequestLike,
  context: { taskId: string; leadAgentId?: string | undefined },
): {
  sourceKey: string;
  kind: "humanGate";
  title: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowFreeText: boolean;
  secret: false;
} => {
  const waiting = request.detail ?? `Pipeline is waiting: ${request.reason}`;
  return {
    sourceKey: `human-gate:${context.taskId}:${request.step.id}:${request.reason}:${String(request.round ?? 0)}`,
    kind: "humanGate",
    title: request.step.name,
    prompt: context.leadAgentId ? `${waiting}\n\nAdditional instructions are sent to Lead.` : waiting,
    options: [
      ...request.allowedActions
        .filter((action) => action !== "rollback")
        .map((action) => ({ id: action, label: action })),
      ...request.rollbackTargets.map((target) => ({
        id: `${ROLLBACK_OPTION_PREFIX}${target.id}`,
        label: `Rollback to ${target.name}`,
      })),
    ],
    allowFreeText: context.leadAgentId !== undefined && context.leadAgentId !== "",
    secret: false,
  };
};

/**
 * The decision a broker's answer amounts to. Free text becomes an intervention for the Lead only
 * when there is a Lead to send it to; the first selection is the action, a rollback option names
 * its target, and anything the gate did not offer is a cancel.
 */
export const humanGateDecisionFromResponse = (
  response: { selected: readonly string[]; freeText: string },
  context: {
    allowedActions: readonly HumanGateAction[];
    stepName: string;
    leadAgentId?: string | undefined;
    interventionId: string;
    now: string;
  },
): HumanGateDecision => {
  const instruction = response.freeText.trim();
  const interventions: PipelineIntervention[] | undefined =
    context.leadAgentId && instruction
      ? [{
          id: context.interventionId,
          agentId: context.leadAgentId,
          prompt: `Human instructions for ${context.stepName}`,
          answer: instruction,
          createdAt: context.now,
        }]
      : undefined;
  const selected = response.selected[0] ?? "cancel";
  if (selected.startsWith(ROLLBACK_OPTION_PREFIX)) {
    return {
      action: "rollback",
      targetStepId: selected.slice(ROLLBACK_OPTION_PREFIX.length),
      ...(interventions ? { interventions } : {}),
    };
  }
  const action = context.allowedActions.find((candidate) => candidate === selected) ?? "cancel";
  return { action, ...(interventions ? { interventions } : {}) };
};

/** What the ledger records when a gate opens for the panel: the gate, in full. */
export const gateOpenedRecord = (request: HumanGateRequestLike): {
  text: string;
  step: string;
  payload: {
    stepId: string;
    reason: PendingHumanGate["reason"];
    round: number | null;
    detail: string | null;
    allowedActions: HumanGateAction[];
    rollbackTargets: { id: string; name: string }[];
  };
} => ({
  text: `Human gate opened: ${request.reason}`,
  step: request.step.name,
  payload: {
    stepId: request.step.id,
    reason: request.reason,
    round: request.round ?? null,
    detail: request.detail ?? null,
    allowedActions: request.allowedActions,
    rollbackTargets: request.rollbackTargets,
  },
});
