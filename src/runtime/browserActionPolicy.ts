import type { BrowserActionCandidate, BrowserActionRisk } from "../browser/actions";

export type BrowserActionPolicySetting =
  | "browserActionReadOnlyPolicy"
  | "browserActionMutationPolicy"
  | "browserActionDestructivePolicy";

export type BrowserActionPreApproval = "approve" | "reject" | "ask";

/** Which setting governs an action, chosen by the risk the extractor assigned it. */
export const browserActionPolicySetting = (
  risk: BrowserActionRisk,
): BrowserActionPolicySetting =>
  risk === "readOnly"
    ? "browserActionReadOnlyPolicy"
    : risk === "destructive"
      ? "browserActionDestructivePolicy"
      : "browserActionMutationPolicy";

/**
 * What can be decided about a browser action without asking the user.
 *
 * `shell.run` is refused before any setting is consulted: no configured policy grants a
 * response the ability to run a command. Automatic approval is deliberately narrow — it
 * needs the configured `auto` policy *and* an action the extractor read out of a structured
 * block *and* explicit confidence. Anything else is `ask`.
 */
export const browserActionPreApproval = (input: {
  kind: BrowserActionCandidate["kind"];
  origin: BrowserActionCandidate["origin"];
  confidence: BrowserActionCandidate["confidence"];
  riskPolicy: string;
}): BrowserActionPreApproval => {
  if (input.kind === "shell.run" || input.riskPolicy === "disabled") {
    return "reject";
  }
  return input.riskPolicy === "auto" &&
    input.origin === "structured" &&
    input.confidence === "explicit"
    ? "approve"
    : "ask";
};

/**
 * The extra approval a managed turn may grant on top of the configured policy.
 *
 * A managed turn is already bounded by its own worktree and check contract, so it may
 * approve a structured, explicit, non-shell action without prompting. It never widens the
 * refusals: anything it does not approve falls back to the configured policy path.
 */
export const managedBrowserActionPreApproval = (input: {
  autoApprove: boolean;
  kind: BrowserActionCandidate["kind"];
  origin: BrowserActionCandidate["origin"];
  confidence: BrowserActionCandidate["confidence"];
}): "approve" | "defer" =>
  input.autoApprove &&
  input.origin === "structured" &&
  input.confidence === "explicit" &&
  input.kind !== "shell.run"
    ? "approve"
    : "defer";

/**
 * EX-3. What the ordinary browser action loop decides between reading a response and running it.
 *
 * The loop asks a provider for actions, puts each to the person, runs the approved ones and asks
 * again. Its own judgements — what a refusal is recorded as and whether it ends the round, when a
 * budget is exhausted and in whose words, and what the executor is allowed to do — sat between the
 * approval call and the filesystem call, so each was reachable only by driving a provider through
 * a real browser and a real approval.
 */
export type BrowserActionRejection = {
  reason: string;
  stopLoop: boolean;
};

/**
 * A refused action is recorded as a result, not dropped: the transcript says the action was seen
 * and what happened to it. "Stop" ends the round as well, and the turn it belongs to is reported
 * interrupted rather than completed — the provider's remaining actions were never put to anyone.
 */
export const browserActionRejection = (decision: "reject" | "stop"): BrowserActionRejection => ({
  reason: decision === "stop" ? "Rejected by user; action loop stopped" : "Rejected by user",
  stopLoop: decision === "stop",
});

export type BrowserActionBudget = {
  actionCount: number;
  pendingActions: number;
  maximumActions: number;
  maximumRounds: number;
  terminalOnlyRound: boolean;
};

export type BrowserActionBudgetRefusal = {
  event: string;
  message: string;
  payload: Record<string, number>;
};

/**
 * Which budget a loop has run out of, if either. A round budget and an action budget bound
 * different runaways — a provider that keeps answering without acting, and one that acts without
 * end — so they are reported separately and in that order: a round that produced only terminal
 * responses has already stopped making progress, whatever the action count says.
 */
export const browserActionBudgetRefusal = (
  budget: BrowserActionBudget,
): BrowserActionBudgetRefusal | undefined => {
  if (budget.terminalOnlyRound) {
    return {
      event: `Browser action loop exhausted ${String(budget.maximumRounds)} action rounds with unexecuted actions.`,
      message: `Browser action round budget exhausted with unexecuted actions (${String(budget.maximumRounds)} rounds)`,
      payload: { maximumRounds: budget.maximumRounds, attemptedActions: budget.pendingActions },
    };
  }
  if (budget.actionCount + budget.pendingActions > budget.maximumActions) {
    return {
      event: `Browser action loop stopped after reaching ${String(budget.maximumActions)} actions.`,
      message: `Browser action budget exhausted with unexecuted actions (${String(budget.maximumActions)} actions)`,
      payload: { maximumActions: budget.maximumActions },
    };
  }
  return undefined;
};

export type BrowserActionLimits = {
  timeoutMs: number;
  terminateGraceMs: number;
  maxOutputBytes: number;
  maxReadBytes: number;
  maxSearchResults: number;
};

/**
 * What a single action is allowed to consume. Every configured value is clamped up to a floor: a
 * zero or negative setting would refuse every action rather than bound it, which reads as a broken
 * provider instead of a misconfigured limit.
 */
export const browserActionLimits = (configured: {
  timeoutMs: number;
  terminateGraceMs: number;
  maxOutputBytes: number;
  maxReadBytes: number;
  maxSearchResults: number;
}): BrowserActionLimits => ({
  timeoutMs: Math.max(1_000, configured.timeoutMs),
  terminateGraceMs: configured.terminateGraceMs,
  maxOutputBytes: Math.max(65_536, configured.maxOutputBytes),
  maxReadBytes: Math.max(65_536, configured.maxReadBytes),
  maxSearchResults: Math.max(10, configured.maxSearchResults),
});

/**
 * The workspace an action may touch. `commitMode` is fixed here and nowhere else: a browser action
 * never commits, whatever the run's own commit mode says, because the bytes that asked for it came
 * from a provider page.
 */
export const browserActionMutationContext = (input: {
  allowedPaths?: readonly string[] | undefined;
  protectedPaths?: readonly string[] | undefined;
  readOnly?: boolean | undefined;
}): {
  allowedPaths: string[];
  restrictedPaths?: string[];
  commitMode: "never";
  readOnly: boolean;
} => ({
  allowedPaths: [...(input.allowedPaths ?? [])],
  ...(input.protectedPaths ? { restrictedPaths: [...input.protectedPaths] } : {}),
  commitMode: "never",
  readOnly: input.readOnly ?? false,
});
