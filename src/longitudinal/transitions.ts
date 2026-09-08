import type {
  FindingLifecycleState,
  HumanResolutionAction,
  LifecycleState,
} from "./types";

export type ResolutionTarget = "finding" | "decision" | "artifact" | "externalEvidence";

const RECORD_ACTIONS: Record<LifecycleState, HumanResolutionAction[]> = {
  proposed: ["accept", "reject", "defer", "supersede"],
  accepted: ["accept", "reject", "defer", "supersede", "reopen"],
  rejected: ["reopen", "supersede"],
  deferred: ["accept", "reject", "supersede"],
  superseded: [],
};

const FINDING_ACTIONS: Record<FindingLifecycleState, HumanResolutionAction[]> = {
  new: ["accept", "reject", "defer", "supersede"],
  repeated: ["accept", "reject", "defer", "supersede"],
  unresolved: ["accept", "reject", "defer", "supersede"],
  regressed: ["accept", "reject", "defer", "supersede"],
  reopened: ["accept", "reject", "defer", "supersede"],
  accepted: ["accept", "reject", "defer", "supersede", "reopen"],
  rejected: ["reopen", "supersede"],
  resolved: ["reopen"],
};

export type ResolutionMatrix = {
  finding: Record<FindingLifecycleState, HumanResolutionAction[]>;
  decision: Record<LifecycleState, HumanResolutionAction[]>;
  artifact: Record<LifecycleState, HumanResolutionAction[]>;
  externalEvidence: Record<LifecycleState, HumanResolutionAction[]>;
};

export const resolutionMatrix = (): ResolutionMatrix => ({
  finding: structuredClone(FINDING_ACTIONS),
  decision: structuredClone(RECORD_ACTIONS),
  artifact: structuredClone(RECORD_ACTIONS),
  externalEvidence: structuredClone(RECORD_ACTIONS),
});

export const allowedResolutionActions = (
  target: ResolutionTarget,
  state: FindingLifecycleState | LifecycleState,
): HumanResolutionAction[] =>
  target === "finding"
    ? FINDING_ACTIONS[state as FindingLifecycleState] ?? []
    : RECORD_ACTIONS[state as LifecycleState] ?? [];

export const resolutionIsAllowed = (
  target: ResolutionTarget,
  state: FindingLifecycleState | LifecycleState,
  action: HumanResolutionAction,
): boolean => allowedResolutionActions(target, state).includes(action);
