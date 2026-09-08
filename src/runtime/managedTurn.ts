/**
 * EX-AUD-12. What a managed browser turn's own result means.
 *
 * The managed action loop in `createRuntime` reads a control envelope, writes a transcript entry,
 * persists a checkpoint, sends the next prompt and does it again. Between those there are
 * judgements: whether the turn read context, whether it applied a patch, whether its terminal
 * claim may advance the pair, which checkpoint events that implies and in which order, what the
 * agent is told next, and whether there is a next turn at all.
 *
 * Every one of them sat between the transcript write and the provider call that surround it, so
 * reaching one meant driving a whole managed run against a browser. They are functions of the
 * envelope, the role and the gate, so they are here. Persisting the checkpoint, writing the
 * transcript and sending the prompt stay in the runtime.
 */

/**
 * The actions that only read. A turn containing one of these is asking to see the workspace, and
 * the pair records that rather than treating the turn as work. The list was written out twice in
 * the runtime — once for the Worker branch and once for the Lead — which is exactly how the two
 * copies would come to disagree about what counts as reading.
 */
export const managedContextActionKinds: readonly string[] = [
  "context.read",
  "context.readTask",
  "context.readMetadata",
  "context.list",
  "context.tree",
  "context.readFile",
  "context.search",
  "context.hashFile",
  "context.dependencies",
  "context.dependents",
];

const managedPatchActionKinds: readonly string[] = [
  "workspace.applyPatch",
  "workspace.write",
  "workspace.delete",
];

export type ManagedEnvelopeLike = {
  status: string;
  summary?: string | undefined;
  objections: readonly string[];
  unresolved: readonly string[];
  actions: readonly { kind: string }[];
};

/**
 * Everything the envelope says is still wrong, once.
 *
 * Objections and unresolved points are two lists a provider can put the same sentence in, and
 * the pair acts on their union: a revision is requested when anything is outstanding, and
 * acceptance requires that nothing is. Deduplicated so a point made twice is not counted twice
 * in what the Worker is asked to fix.
 */
export const managedTurnObjections = (
  envelope: ManagedEnvelopeLike | undefined,
): string[] =>
  envelope ? [...new Set([...envelope.objections, ...envelope.unresolved])] : [];

export const managedTurnReadsContext = (envelope: ManagedEnvelopeLike): boolean =>
  envelope.actions.some((action) => managedContextActionKinds.includes(action.kind));

export const managedTurnWritesWorkspace = (envelope: ManagedEnvelopeLike): boolean =>
  envelope.actions.some((action) => managedPatchActionKinds.includes(action.kind));

export const managedTurnRequestsVerification = (envelope: ManagedEnvelopeLike): boolean =>
  envelope.actions.some((action) => action.kind === "verification.run");

/**
 * Whether a turn that claims to be finished may actually advance the pair.
 *
 * A terminal claim held back by the verification gate is not an advance: it is a turn that says
 * it is done while the checks that would show it say otherwise. Named on its own because the loop
 * asks the same question three times — for the checkpoint, for the next prompt, and for whether
 * to keep going — and three copies of it could disagree.
 */
export const managedTerminalAdvances = (input: {
  terminal: boolean;
  verificationGateHolds: boolean;
}): boolean => input.terminal && !input.verificationGateHolds;

export type ManagedCheckpointStep =
  | { event: "workerNeedsContext" }
  | { event: "workerRequestedPatch" }
  | { event: "patchApplied" }
  | { event: "revisionApplied" }
  | { event: "verificationCompleted" }
  | { event: "workerDone" }
  | { event: "leadNeedsContext" }
  | { event: "leadAccepted" }
  | { event: "leadRequestedRevision"; objections: readonly string[] }
  | { event: "blocked"; reason: string };

export type ManagedCheckpointInput = {
  role: string;
  /** The pair state before any of these events is applied. */
  state: string;
  envelope: ManagedEnvelopeLike;
  /** Whether any action in this turn actually completed. */
  anyActionCompleted: boolean;
  /** Whether this Worker turn is answering a Lead's revision rather than doing first work. */
  isRevision: boolean;
  terminal: boolean;
  verificationGateHolds: boolean;
};

const blockedReason = (
  envelope: ManagedEnvelopeLike,
  objections: readonly string[],
  fallback: string,
): string => objections.join("; ") || envelope.summary || fallback;

/**
 * Which checkpoint events one managed turn produces, in order.
 *
 * The order is behaviour: a Worker that read context and then applied a patch records both, and
 * records the patch after the read, because the pair's state machine only accepts an applied
 * patch from a state a requested patch put it in. A patch that produced no completed action is
 * not an applied patch — a turn that asked to write and whose write failed has changed nothing,
 * and recording it as applied would let the Worker finish on work that never landed.
 *
 * Only a state the pair is actually in produces events: a Worker turn arriving while the pair
 * has already moved to the Lead records nothing, rather than driving the machine backwards.
 *
 * A terminal turn is recorded only when the verification gate lets it advance. That is what stops
 * a Worker from finishing, and a Lead from accepting, over checks that never ran.
 */
export const managedCheckpointSteps = (
  input: ManagedCheckpointInput,
): ManagedCheckpointStep[] => {
  const { envelope, state } = input;
  const steps: ManagedCheckpointStep[] = [];
  const objections = managedTurnObjections(envelope);
  const advances = managedTerminalAdvances(input);
  if (input.role === "worker") {
    if (!state.startsWith("WORKER_")) return steps;
    if (managedTurnReadsContext(envelope)) {
      steps.push({ event: "workerNeedsContext" });
    }
    if (managedTurnWritesWorkspace(envelope) && input.anyActionCompleted) {
      steps.push({ event: "workerRequestedPatch" });
      steps.push({ event: input.isRevision ? "revisionApplied" : "patchApplied" });
    }
    if (managedTurnRequestsVerification(envelope)) {
      steps.push({ event: "verificationCompleted" });
    }
    if (advances) {
      steps.push(
        envelope.status === "blocked"
          ? { event: "blocked", reason: blockedReason(envelope, objections, "Worker blocked the task") }
          : { event: "workerDone" },
      );
    }
    return steps;
  }
  if (!state.startsWith("LEAD_")) return steps;
  if (managedTurnReadsContext(envelope)) {
    steps.push({ event: "leadNeedsContext" });
  }
  if (advances) {
    if (envelope.status === "blocked") {
      steps.push({ event: "blocked", reason: blockedReason(envelope, objections, "Lead blocked the task") });
    } else if (objections.length === 0) {
      steps.push({ event: "leadAccepted" });
    } else {
      steps.push({ event: "leadRequestedRevision", objections });
    }
  }
  return steps;
};

/**
 * What the agent is told next.
 *
 * A held turn is not sent its own next prompt: it is told, in the checks' own ids and words, what
 * is not passing, and what its role may do about it. A Worker is told to fix and verify; a Lead
 * is told not to approve, and that returning objections or blocking is the way out if the failure
 * needs the Worker. Anything else keeps the prompt the controller produced.
 */
export const managedNextPrompt = (input: {
  verificationGateHolds: boolean;
  role: string;
  issues: readonly string[];
  protocolPrompt: string;
  nextPrompt?: string | undefined;
}): string | undefined => {
  if (!input.verificationGateHolds) return input.nextPrompt;
  return [
    "Bachata cannot advance this managed turn because required controller-defined verification is not passing.",
    `Required verification: ${input.issues.join(", ")}`,
    input.role === "worker"
      ? "Continue the task. Fix the implementation if needed, then request verification.run for every required check before returning done."
      : "Do not approve the task while verification is missing or failing. Request verification.run, or return objections/blocked if the failure requires Worker changes.",
    input.protocolPrompt,
  ].join("\n\n");
};

/**
 * Whether the loop runs another controlled turn.
 *
 * It stops for three different reasons and they are not interchangeable: the turn finished and
 * was allowed to, there is nothing left to say to the agent, or the user cancelled. A held
 * terminal turn is none of those — it has a prompt waiting and the loop goes round again.
 */
export const managedTurnContinues = (input: {
  terminal: boolean;
  verificationGateHolds: boolean;
  nextPrompt?: string | undefined;
  aborted: boolean;
}): boolean =>
  !managedTerminalAdvances(input)
  && Boolean(input.nextPrompt)
  && !input.aborted;
