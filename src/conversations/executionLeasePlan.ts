import { repositoryExecutionClaims } from "../concurrency/repositoryResources";
import type { WorkingResourceIdentity } from "../concurrency/repositoryResources";
import type { ResourceClaim, ResourceLease } from "../concurrency/resourceBroker";

/**
 * EX-3. The execution-lease state machine, apart from the broker that grants leases.
 *
 * A conversation holds one shared execution lease, and every operation inside it retains a share.
 * The rules for what that share costs, when a retention is refused, when a release closes the
 * lease, when a checklist may suspend it and when a suspended one may be taken back were spread
 * across four `async` functions that each acquire from a broker, release physical leases and
 * quarantine on failure. None of them could be reached without a broker and a runtime.
 *
 * The transitions are here; acquiring, releasing and quarantining stay with the caller.
 */
export type LocalAgentDemand = {
  persistentAgentIds: string[];
  transientSlots: number;
  totalUnits: number;
};

/**
 * The demand as the lease accounts for it: each persistent agent named once, and no negative
 * slot counts, whatever the pipeline asked for.
 */
export const normalizedLocalAgentDemand = (requested: {
  persistentAgentIds: readonly string[];
  transientSlots: number;
  totalUnits: number;
}): LocalAgentDemand => ({
  persistentAgentIds: Array.from(new Set(requested.persistentAgentIds)),
  transientSlots: Math.max(0, requested.transientSlots),
  totalUnits: Math.max(0, requested.totalUnits),
});

/**
 * Why a demand cannot be met at all. A demand whose total is under what it itself names is a
 * defect rather than a capacity problem, and is refused before the configured ceiling is even
 * consulted; a demand over the ceiling names both numbers so the reader can change one.
 */
export const localAgentDemandRefusal = (
  demand: LocalAgentDemand,
  maxLocalAgents: number,
): string | undefined => {
  if (demand.totalUnits < demand.persistentAgentIds.length + demand.transientSlots) {
    return "Local-provider demand is internally inconsistent";
  }
  if (demand.totalUnits > maxLocalAgents) {
    return `This operation needs ${String(demand.totalUnits)} concurrent local provider processes, but bachata.maxConcurrentLocalAgents is ${String(maxLocalAgents)}`;
  }
  return undefined;
};

export type ExecutionTopUp = {
  newPersistentAgentIds: string[];
  additionalUnits: number;
  aggregateDemand: number;
};

/**
 * What a second operation in a conversation that already holds a lease has to reserve.
 *
 * A persistent agent the conversation already reserved costs nothing again — the process is
 * already running and is reused — so only agents new to this lease and the transient slots are
 * added. The aggregate is checked against the same ceiling a first retention is, because the
 * ceiling is on processes, not on operations.
 */
export const executionTopUpPlan = (input: {
  reservedLocalAgents: number;
  reservedPersistentAgents: readonly string[];
  demand: LocalAgentDemand;
  maxLocalAgents: number;
  userAlreadyRetained: boolean;
}): { refusal: string; topUp?: undefined } | { refusal?: undefined; topUp: ExecutionTopUp } => {
  if (input.userAlreadyRetained) {
    return { refusal: "Execution ownership user is already retained" };
  }
  const reserved = new Set(input.reservedPersistentAgents);
  const newPersistentAgentIds = input.demand.persistentAgentIds.filter(
    (agentId) => !reserved.has(agentId),
  );
  const additionalUnits = newPersistentAgentIds.length + input.demand.transientSlots;
  const aggregateDemand = input.reservedLocalAgents + additionalUnits;
  if (aggregateDemand > input.maxLocalAgents) {
    return {
      refusal: `Concurrent work in this conversation needs ${String(aggregateDemand)} local provider processes, but bachata.maxConcurrentLocalAgents is ${String(input.maxLocalAgents)}`,
    };
  }
  return { topUp: { newPersistentAgentIds, additionalUnits, aggregateDemand } };
};

/**
 * Whether the reservation a top-up took is still attached to the lease it was taken for.
 *
 * The physical reservations happen outside the mutation queue, so the conversation can release
 * its whole lease while they are in flight. Committing them anyway would attach processes to a
 * lease nobody holds, so the reservation is abandoned instead.
 */
export const topUpReservationHolds = (input: {
  currentStateIsTopUpState: boolean;
  closing: boolean;
}): boolean => input.currentStateIsTopUpState && !input.closing;

export type ExecutionReleasePlan =
  /** A suspended retention that was never taken back: forget it and release nothing. */
  | { action: "dropSuspended" }
  /** Nothing here holds this user's share. */
  | { action: "none" }
  | { action: "release"; releaseTransient: boolean; closeLease: boolean };

/**
 * What releasing one user's share does.
 *
 * The last user closes the lease; anyone before them only gives back what they reserved. A user
 * whose retention was suspended for a checklist and whose lease is gone is dropped rather than
 * released, because there is nothing left to release it against.
 */
export const executionReleasePlan = (input: {
  suspendedUserId?: string | undefined;
  userId: string;
  hasLease: boolean;
  isKnownUser: boolean;
  remainingUsersAfterRelease: number;
  hasTransientLease: boolean;
}): ExecutionReleasePlan => {
  if (input.suspendedUserId === input.userId && !input.hasLease) {
    return { action: "dropSuspended" };
  }
  if (!input.hasLease || !input.isKnownUser) return { action: "none" };
  return {
    action: "release",
    releaseTransient: input.hasTransientLease,
    closeLease: input.remainingUsersAfterRelease === 0,
  };
};

/**
 * Why a checklist may not suspend the lease. Suspension hands the whole lease back while the
 * checklist runs in its own conversation, so it is only safe when this conversation's lease has
 * exactly one user and is not already closing — anything else would pull the lease out from under
 * work that is still running.
 */
export const checklistSuspensionRefusal = (input: {
  hasLease: boolean;
  closing: boolean;
  userCount: number;
}): string | undefined =>
  input.hasLease && !input.closing && input.userCount === 1
    ? undefined
    : "Checklist execution requires exclusive ownership of the parent execution lease";

export type ContinuationLeasePlan =
  | { action: "assertHeld" }
  | { action: "retakeSuspended" }
  | { refusal: string };

/**
 * What the next iteration of a run needs. A lease still held is only checked; a suspended one is
 * taken back under the same user and demand it was suspended with, so the iteration continues on
 * the reservation it started with rather than a new one.
 */
export const continuationLeasePlan = (input: {
  hasLease: boolean;
  hasSuspended: boolean;
}): ContinuationLeasePlan => {
  if (input.hasLease) return { action: "assertHeld" };
  if (input.hasSuspended) return { action: "retakeSuspended" };
  return { refusal: "Execution ownership was lost before the next iteration" };
};

/** Every lease a conversation's execution state holds, each named once. */
export const executionStateLeaseIds = (state: {
  leaseId: string;
  persistentLeaseIds: readonly string[];
  transientLeaseIds: readonly (string | undefined)[];
}): string[] =>
  Array.from(
    new Set([
      state.leaseId,
      ...state.persistentLeaseIds,
      ...state.transientLeaseIds.filter((id): id is string => id !== undefined),
    ]),
  );

/**
 * Wraps a release so it runs once. A caller that releases twice — a `finally` after an explicit
 * release, a retry — would otherwise give back a share the conversation no longer holds.
 */
export const releaseOnce = (release: () => Promise<void>): (() => Promise<void>) => {
  let released = false;
  return async (): Promise<void> => {
    if (released) return;
    released = true;
    await release();
  };
};

/**
 * The resources a conversation's first execution lease asks the broker for.
 *
 * Three claims in a fixed order: the global run cap, the repository's own claims (a managed task
 * takes one unit of the repository plus its worktree, an ordinary run takes the whole repository),
 * and — only when the pipeline actually starts local providers — the global local-agent pool for
 * exactly the units it needs. Capacities read from settings are clamped to at least one, because a
 * zero would refuse every run rather than serialise them.
 */
export const executionResourceClaims = (input: {
  identity: WorkingResourceIdentity;
  managedTask: boolean;
  pairRunCapacity: number;
  repositoryCapacity: number;
  demandUnits: number;
  maxLocalAgents: number;
}): ResourceClaim[] => {
  const localAgents: ResourceClaim[] = input.demandUnits > 0
    ? [{
        key: "local-agents:global",
        units: input.demandUnits,
        capacity: input.maxLocalAgents,
        kind: "physical",
      }]
    : [];
  return [
    { key: "bachata-runs:global", capacity: Math.max(1, input.pairRunCapacity) },
    ...repositoryExecutionClaims(input.identity, {
      managedTask: input.managedTask,
      repositoryCapacity: Math.max(1, input.repositoryCapacity),
    }),
    ...localAgents,
  ];
};

/** The reasons of every settled result that rejected, in order. */
export const rejectedReasons = (results: readonly PromiseSettledResult<unknown>[]): unknown[] =>
  results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));

/**
 * What closing a lease reports.
 *
 * Releases that failed are one aggregate, so a caller sees every resource that was not given back
 * rather than the first. When the close then falls back to quarantine and that fails too, the
 * original failure travels first and every quarantine failure after it — a quarantine that did
 * not stick is worse news than the release it was covering for, and both are said.
 */
export const leaseReleaseFailure = (releaseFailures: readonly unknown[]): AggregateError | undefined =>
  releaseFailures.length === 0
    ? undefined
    : new AggregateError([...releaseFailures], "One or more execution resources could not be released");

export const leaseQuarantineOutcome = (
  error: unknown,
  quarantineFailures: readonly unknown[],
): unknown =>
  quarantineFailures.length === 0
    ? error
    : new AggregateError(
        [error, ...quarantineFailures],
        "Provider cleanup failed and its execution resources could not be quarantined",
      );

/** What the quarantine is told when a close failed: the failure, in the reader's words. */
export const quarantineReasonFor = (error: unknown): string =>
  `Provider cleanup was not confirmed: ${error instanceof Error ? error.message : String(error)}`;

/**
 * The lease a conversation holds when no broker is configured: always valid, releases nothing,
 * quarantines nothing. It exists so the code that holds a lease never has to ask whether one is
 * real, and it is named after the conversation so a log line can still say whose it was.
 */
export const localExecutionLease = (input: { id: string; resources: ResourceClaim[] }): ResourceLease => ({
  id: input.id,
  resources: input.resources,
  fences: {},
  signal: new AbortController().signal,
  isValid: () => true,
  assertValid: () => undefined,
  release: async () => undefined,
  quarantine: async () => undefined,
});
