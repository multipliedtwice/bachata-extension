import { InteractionRecord, StateCatalog } from "./catalog";

export type DeadlineScheduler = {
  start: () => void;
  wake: () => void;
  dispose: () => void;
};

type DeadlineTimerHandle = ReturnType<typeof setTimeout> | number;

export type DeadlineSchedulerOptions = {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => DeadlineTimerHandle;
  clearTimer?: (timer: DeadlineTimerHandle) => void;
  onTimeout: (interaction: InteractionRecord) => Promise<void>;
  onError?: (error: unknown) => void;
};

export const createDeadlineScheduler = (
  catalog: StateCatalog,
  options: DeadlineSchedulerOptions,
): DeadlineScheduler => {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: DeadlineTimerHandle | undefined;
  let running = false;
  let disposed = false;
  let rerun = false;

  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  const schedule = (): void => {
    if (disposed) {
      return;
    }
    if (timer) {
      clearTimer(timer);
      timer = undefined;
    }
    const next = catalog.nextDeadlineAt();
    if (!next) {
      return;
    }
    const delay = Math.max(0, Date.parse(next) - now());
    timer = setTimer(() => {
      timer = undefined;
      void process();
    }, Math.min(delay, 2_147_483_647));
  };

  const process = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      catalog.resolveDueInteractions();
      const pending = catalog.listUnhandledTimeouts();
      for (const interaction of pending) {
        if (disposed) {
          return;
        }
        try {
          await options.onTimeout(interaction);
          catalog.markInteractionHandled(interaction.interactionRef);
        } catch (error) {
          report(error);
        }
      }
    } catch (error) {
      report(error);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        void process();
      } else {
        schedule();
      }
    }
  };

  return {
    start: () => {
      void process();
    },
    wake: () => {
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
      void process();
    },
    dispose: () => {
      disposed = true;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
    },
  };
};
