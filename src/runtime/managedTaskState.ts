import { ControllerEvidenceLine } from "./controllerVerification";
import { ManagedLeadDefect } from "./managedLeadReview";

/**
 * What a rejected Worker is owed on its next turn: the defects the Lead named, and the
 * controller's own results for the candidate the Lead judged.
 */
export type ManagedLeadRevisionDirective = {
  candidate: string;
  summary: string;
  defects: ManagedLeadDefect[];
  evidence: ControllerEvidenceLine[];
};

/**
 * The managed local review state of ONE task, and no more than one.
 *
 * WHAT THIS REPLACES, AND WHY THE OLD SHAPE WAS WRONG IN A WAY THAT DID NOT SHOW. The revision
 * counter and the pending Lead directive were two runtime-wide `Map`s keyed by task id. The
 * counter had no `delete` anywhere, and the directive was removed only when a Worker turn
 * consumed it — so a Lead that rejected a task whose Worker then failed, was interrupted or was
 * never enabled left an entry no code would ever read again. Nothing leaked ACROSS tasks, because
 * `state.taskId` is a fresh `randomUUID()` per task and a retained entry belongs to an identifier
 * that never comes back. What did grow was memory: one entry per revised task, for as long as the
 * Extension Host lived. That is unbounded, not bounded, and "the key never repeats" is the reason
 * it was invisible rather than the reason it was safe.
 *
 * The shape here makes the lifetime the structure's own property rather than a rule someone has
 * to remember at eight call sites. There is one slot. Touching it for a different task discards
 * what the previous task left, so the accumulation cannot happen at all — no `delete` scattered
 * through unrelated catch and finally branches, and no way to forget one. The explicit `clear`
 * exists for the boundaries where nothing else will be touched afterwards: the end of a run, a
 * task reset, a programmatic session reset and runtime disposal, so an idle runtime holds nothing
 * from the task it just finished.
 *
 * This is not a cache and must not become one. Reading another task's budget is exactly the
 * authorization defect a single slot makes unrepresentable.
 */
export type ManagedTaskState = {
  /** Spend one revision cycle for this task and answer how many it has now spent. */
  spendRevision: (taskId: string) => number;
  /** How many revision cycles this task has spent. A task that has spent none has spent none. */
  revisionsUsed: (taskId: string) => number;
  /** Hold what a rejected Worker is owed, until its next turn or the end of the task. */
  holdLeadRevision: (taskId: string, directive: ManagedLeadRevisionDirective) => void;
  /** Take what the Worker is owed, once. A second turn in the same task is owed nothing. */
  takeLeadRevision: (taskId: string) => ManagedLeadRevisionDirective | undefined;
  /** Forget everything. The task that follows starts from nothing, whatever happened to this one. */
  clear: () => void;
};

export const createManagedTaskState = (): ManagedTaskState => {
  let current:
    | {
        taskId: string;
        revisions: number;
        pending: ManagedLeadRevisionDirective | undefined;
      }
    | undefined;

  const own = (taskId: string): {
    taskId: string;
    revisions: number;
    pending: ManagedLeadRevisionDirective | undefined;
  } => {
    if (current?.taskId !== taskId) {
      current = { taskId, revisions: 0, pending: undefined };
    }
    return current;
  };

  return {
    spendRevision: (taskId) => {
      const task = own(taskId);
      task.revisions += 1;
      return task.revisions;
    },
    revisionsUsed: (taskId) => (current?.taskId === taskId ? current.revisions : 0),
    holdLeadRevision: (taskId, directive) => {
      own(taskId).pending = directive;
    },
    takeLeadRevision: (taskId) => {
      if (current?.taskId !== taskId) {
        return undefined;
      }
      const pending = current.pending;
      current.pending = undefined;
      return pending;
    },
    clear: () => {
      current = undefined;
    },
  };
};
