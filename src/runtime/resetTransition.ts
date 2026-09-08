/**
 * EX-AUD-12. What a task reset leaves each agent as.
 *
 * The reset itself is I/O from beginning to end — abort, interrupt, clear the transcript, clear
 * the attachments, persist, roll back on failure — and it stays in `createRuntime`. This is the
 * one judgement inside it that is not: given the agents the reset kept and the browser sessions
 * still alive, what each agent's status becomes and whether it keeps the session it had.
 */

export type ResetAgentLike = {
  adapterType: string;
  sessionId?: string | undefined;
  version?: string | undefined;
  browserBinding?:
    | { provider: string; conversationIdentity: string }
    | undefined;
};

export type ResetSessionLike = {
  id: string;
  status: string;
  provider: string;
  conversationIdentity: string;
};

/**
 * The live browser session this agent is still bound to, if any.
 *
 * Two ways to be the same session, and both are needed: the id the agent recorded, and — when
 * the bridge has renumbered its sessions across a reconnect — the provider and conversation the
 * agent was bound to. Matching on the id alone would drop a binding that is still on screen;
 * matching on the conversation alone would adopt a session the agent never had.
 */
export const resetBoundSession = <T extends ResetSessionLike>(
  agent: ResetAgentLike,
  sessions: readonly T[],
): T | undefined =>
  sessions.find(
    (session) =>
      session.status === "ready" &&
      (session.id === agent.sessionId ||
        (agent.browserBinding !== undefined &&
          session.provider === agent.browserBinding.provider &&
          session.conversationIdentity === agent.browserBinding.conversationIdentity)),
  );

export type ResetAgentProjection = {
  status: "idle" | "available" | "unknown";
  /** Whether the agent keeps the session id it had. */
  keepsSession: boolean;
};

/**
 * What one agent looks like after a reset.
 *
 * A browser agent's session belongs to the browser, not to the task, so a reset never takes it
 * away: it is `idle` while its conversation is still there and `available` once it is not, and
 * it keeps its session id either way so a later reconnect can find it again.
 *
 * A local agent is the other way round. Its session was this task's, so the reset ends it, and
 * what is left is a version or the absence of one: an agent whose version was probed is
 * `available`, and one that was never reached stays `unknown` rather than being reported ready.
 */
export const resetAgentProjection = (
  agent: ResetAgentLike,
  sessions: readonly ResetSessionLike[],
): ResetAgentProjection => {
  if (agent.adapterType.endsWith("-browser")) {
    return {
      status: resetBoundSession(agent, sessions) ? "idle" : "available",
      keepsSession: true,
    };
  }
  return { status: agent.version ? "available" : "unknown", keepsSession: false };
};

/**
 * EX-3. What a failed task reset may undo, decided from how far it got.
 *
 * A reset interrupts a run, backs up the transcript and attachments, clears both, installs a new
 * adapter topology and persists. A failure anywhere in that sequence has to undo exactly the parts
 * that happened — and no more. Restoring stores that were never cleared would replace live content
 * with a stale copy; disposing a topology that was already committed would tear down the adapters
 * the runtime is now using; persisting again when nothing was persisted would write a record for a
 * reset that never happened.
 *
 * The conditions were four inline expressions inside one 160-line `catch`, reachable only by
 * making a real reset fail at each of its phases.
 */
export type TaskResetPhase = {
  /** The transcript and attachment stores have been cleared. */
  destructivePhaseStarted: boolean;
  /** A snapshot of the panel state was taken before the clear. */
  hasStateBackup: boolean;
  /** Both store backups were taken before the clear. */
  hasStoreBackups: boolean;
  /** A replacement topology exists, whether or not it was committed. */
  transitionPrepared: boolean;
  transitionCommitted: boolean;
  /** The new runtime record reached storage. */
  runtimeStatePersisted: boolean;
};

export type TaskResetRollbackPlan = {
  /** Put the transcript, the attachments and the panel state back. */
  restoreStores: boolean;
  /** Roll the transition back and dispose the topology it built. */
  rollbackTransition: boolean;
  /** The task id was taken but nothing was cleared, so it goes back. */
  restoreTaskId: boolean;
  /** Memory and storage now disagree, so the record is written again. */
  persistAgain: boolean;
};

export const taskResetRollbackPlan = (phase: TaskResetPhase): TaskResetRollbackPlan => {
  const restoreStores =
    phase.destructivePhaseStarted && phase.hasStateBackup && phase.hasStoreBackups;
  return {
    restoreStores,
    rollbackTransition: phase.transitionPrepared && !phase.transitionCommitted,
    restoreTaskId: !phase.destructivePhaseStarted,
    // Either the state was put back, or it never moved; both leave storage holding something the
    // runtime is no longer running. A destructive phase with no usable backup is neither, and is
    // left alone rather than written over with a half-reset record.
    persistAgain: phase.runtimeStatePersisted && (restoreStores || !phase.destructivePhaseStarted),
  };
};

export const TASK_RESET_ROLLBACK_INCOMPLETE = "Task reset failed and rollback was incomplete";
