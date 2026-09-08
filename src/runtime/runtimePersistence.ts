import { WorkspaceMutationRunner } from "../state/workspaceMutationFence";

/**
 * EX-3. Writing the runtime's persisted state, lifted out of the composition root.
 *
 * Three rules travel together and are the whole reason this is one thing rather than three calls
 * at each site:
 *
 *  1. Writes are serialised. Two overlapping writes of a whole state value can land in either
 *     order, and the loser is the state the runtime is actually in.
 *  2. A queued debounce is cancelled by any write that starts. A timer that survives an explicit
 *     write fires afterwards with a value read later, which is a second write nobody asked for.
 *  3. The value is read at write time, not at call time, and cloned before it leaves. A snapshot
 *     taken when the write was queued is already stale by the time the queue reaches it, and a
 *     value still referenced by live state can be mutated after it was handed over.
 *
 * Writability is asserted twice on purpose: once when the write is asked for, so a refusal is
 * raised at the call site that caused it, and once inside the mutation, because a workspace can
 * become read-only while a write waits its turn.
 */
export type RuntimePersistence<Value extends object> = {
  /** Write whatever the factory returns when the queue reaches this write. */
  persistValue: (
    valueFactory: () => Value,
    afterWrite?: () => void,
  ) => Promise<void>;
  /** Write the current state with these fields replaced. */
  persistPatch: (
    patch: Partial<Value>,
    afterWrite?: () => void,
  ) => Promise<void>;
  /** Write the current state now. */
  persistNow: () => Promise<void>;
  /** Write the current state shortly, coalescing anything else asked for meanwhile. */
  schedulePersist: () => void;
  /** Drop a pending debounce without writing. */
  cancelScheduledPersist: () => void;
  /**
   * Settle once every write queued so far has finished, however it finished. A caller shutting
   * down needs the queue empty, not the outcome of writes it did not ask for.
   */
  drain: () => Promise<void>;
};

export const createRuntimePersistence = <Value extends object>(input: {
  snapshot: () => Value;
  write: (value: Value) => Promise<void>;
  withMutation: WorkspaceMutationRunner;
  assertWritable?: (() => void) | undefined;
  log: (message: string) => void;
  debounceMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}): RuntimePersistence<Value> => {
  const debounceMs = input.debounceMs ?? 100;
  const setTimer = input.setTimer ?? setTimeout;
  const clearTimer = input.clearTimer ?? clearTimeout;
  let timer: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();

  const cancelScheduledPersist = (): void => {
    if (timer) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const persistValue = (
    valueFactory: () => Value,
    afterWrite?: () => void,
  ): Promise<void> => {
    input.assertWritable?.();
    cancelScheduledPersist();
    const write = (): Promise<void> => input.withMutation(async () => {
      input.assertWritable?.();
      await input.write(structuredClone(valueFactory()));
      afterWrite?.();
    });
    // Both arms run the write: a failed predecessor must not cancel the writes queued behind it.
    const operation = queue.then(write, write);
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const persistPatch = (
    patch: Partial<Value>,
    afterWrite?: () => void,
  ): Promise<void> => {
    const stablePatch = structuredClone(patch);
    return persistValue(() => ({ ...input.snapshot(), ...stablePatch }), afterWrite);
  };

  const persistNow = (): Promise<void> => persistValue(input.snapshot);

  const schedulePersist = (): void => {
    cancelScheduledPersist();
    timer = setTimer(() => {
      timer = undefined;
      void persistNow().catch((error) => {
        input.log(
          `Failed to persist runtime state: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, debounceMs);
  };

  const drain = (): Promise<void> => queue;

  return { persistValue, persistPatch, persistNow, schedulePersist, cancelScheduledPersist, drain };
};
