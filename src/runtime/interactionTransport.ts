export type InteractionQueue = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * One provider interaction at a time. A second prompt raised while the first is on screen would
 * take the widget away from it, so operations are chained; a rejected operation still lets the
 * next one run, because a refused approval is not a reason to stop asking.
 */
export const createInteractionQueue = (): InteractionQueue => {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
};

export type TimedInputResult<T> = {
  value: T | undefined;
  timedOut: boolean;
};

export type WidgetSubscription = { dispose: () => void };

/**
 * The editor widget a bounded prompt drives, reduced to what the bound needs: when the user
 * accepts, when it goes away, what was chosen, and how to take it down.
 */
export type BoundedWidget<T> = {
  onAccept: (listener: () => void) => WidgetSubscription;
  onHide: (listener: () => void) => WidgetSubscription;
  accepted: () => T | undefined;
  show: () => void;
  hide: () => void;
  dispose: () => void;
};

/**
 * Where the one cancellable prompt in flight is recorded, so an interrupt can take it down.
 * Release is identity-checked: a prompt that has already been replaced must not clear its
 * successor's claim on the way out.
 */
export type ActiveInputSlot = {
  claim: (agentId: string, cancel: () => void) => void;
  release: (cancel: () => void) => void;
};

export type BoundedPromptHost<T> = {
  agentId: string;
  deadline: number | undefined;
  now: () => number;
  /** The editor's own modal prompt, used when the turn has no deadline to answer within. */
  unbounded: () => Promise<T | undefined>;
  createWidget: () => BoundedWidget<T>;
  slot: ActiveInputSlot;
  schedule: (delayMs: number, onDeadline: () => void) => unknown;
  cancelSchedule: (handle: unknown) => void;
};

/**
 * Ask the user something the turn is waiting on, and give up when the turn does.
 *
 * A prompt with no deadline is the editor's ordinary one. A prompt with a deadline that has
 * already passed is not shown at all — putting a widget on screen only to remove it a moment
 * later reads as the editor glitching. Otherwise the widget is shown and settled exactly once, by
 * whichever of acceptance, dismissal, the deadline or an interrupt arrives first; every later
 * arrival is ignored, so a dismissal racing the timer cannot resolve the prompt twice.
 *
 * Dismissal and the deadline both yield no value, and they are told apart: a user who closed the
 * prompt answered it, and a turn that ran out of time did not.
 */
export const promptWithDeadline = async <T>(
  host: BoundedPromptHost<T>,
): Promise<TimedInputResult<T>> => {
  if (host.deadline === undefined) {
    return { value: await host.unbounded(), timedOut: false };
  }
  const remaining = host.deadline - host.now();
  if (remaining <= 0) {
    return { value: undefined, timedOut: true };
  }
  const widget = host.createWidget();
  return await new Promise<TimedInputResult<T>>((resolve) => {
    let settled = false;
    let timer: unknown;
    const subscriptions: WidgetSubscription[] = [];
    const settle = (value: T | undefined, timedOut: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        host.cancelSchedule(timer);
      }
      subscriptions.forEach((subscription) => subscription.dispose());
      host.slot.release(cancel);
      widget.hide();
      widget.dispose();
      resolve({ value, timedOut });
    };
    const cancel = (): void => settle(undefined, false);
    subscriptions.push(
      widget.onAccept(() => settle(widget.accepted(), false)),
      widget.onHide(cancel),
    );
    host.slot.claim(host.agentId, cancel);
    timer = host.schedule(remaining, () => settle(undefined, true));
    widget.show();
  });
};
