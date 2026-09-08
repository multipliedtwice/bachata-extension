const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createInteractionQueue,
  promptWithDeadline,
} = require("../dist/runtime/interactionTransport.js");

// EX-3. Asking the user something a turn is waiting on. The quick pick and the input box were two
// near-identical closures inside `createRuntime`, each with its own settle-once flag, its own
// timer and its own copy of the active-input bookkeeping, so a dismissal racing the deadline could
// only be reached by driving the whole runtime against a real VS Code window.

const widget = (overrides = {}) => {
  const listeners = { accept: [], hide: [] };
  const calls = { shown: 0, hidden: 0, disposed: 0, unsubscribed: 0 };
  const subscribe = (bucket) => (listener) => {
    listeners[bucket].push(listener);
    return { dispose: () => { calls.unsubscribed += 1; } };
  };
  return {
    calls,
    accept: (value) => { calls.acceptedValue = value; listeners.accept.forEach((fn) => fn()); },
    hide: () => listeners.hide.forEach((fn) => fn()),
    widget: {
      onAccept: subscribe("accept"),
      onHide: subscribe("hide"),
      accepted: () => calls.acceptedValue,
      show: () => { calls.shown += 1; },
      hide: () => { calls.hidden += 1; },
      dispose: () => { calls.disposed += 1; },
      ...overrides,
    },
  };
};

const slot = () => {
  const claimed = [];
  let current;
  return {
    claimed,
    current: () => current,
    slot: {
      claim: (agentId, cancel) => { claimed.push(agentId); current = cancel; },
      release: (cancel) => { if (current === cancel) current = undefined; },
    },
  };
};

const host = (overrides) => {
  const timers = [];
  return {
    timers,
    host: {
      agentId: "codex",
      now: () => 1_000,
      unbounded: async () => "modal answer",
      schedule: (delayMs, onDeadline) => {
        timers.push({ delayMs, onDeadline, cancelled: false });
        return timers.length - 1;
      },
      cancelSchedule: (handle) => { timers[handle].cancelled = true; },
      ...overrides,
    },
  };
};

test("a queued interaction waits for the one before it, and a rejection does not stop the queue", async () => {
  // WHY. A second prompt raised while the first is on screen takes the widget away from it. A
  // refused approval is not a reason to stop asking the next question.
  const order = [];
  const enqueue = createInteractionQueue();
  const first = enqueue(async () => {
    order.push("first-start");
    await new Promise((resolve) => setImmediate(resolve));
    order.push("first-end");
    throw new Error("refused");
  });
  const second = enqueue(async () => {
    order.push("second");
    return "ok";
  });
  await assert.rejects(first, /refused/);
  assert.equal(await second, "ok");
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("with no deadline the editor's own modal prompt answers, and no widget is built", async () => {
  let built = false;
  const { host: hostValue } = host({
    deadline: undefined,
    createWidget: () => { built = true; return widget().widget; },
    slot: slot().slot,
  });
  assert.deepEqual(await promptWithDeadline(hostValue), {
    value: "modal answer",
    timedOut: false,
  });
  assert.equal(built, false);
});

test("a deadline already past shows nothing at all", async () => {
  // WHY NOT SHOW IT. Putting a widget on screen only to remove it a moment later reads as the
  // editor glitching, and the turn it belonged to is over either way.
  let built = false;
  const { host: hostValue } = host({
    deadline: 500,
    createWidget: () => { built = true; return widget().widget; },
    slot: slot().slot,
  });
  assert.deepEqual(await promptWithDeadline(hostValue), { value: undefined, timedOut: true });
  assert.equal(built, false);
});

test("accepting settles with the widget's value, cancels the timer and frees the slot", async () => {
  const target = widget();
  const holder = slot();
  const { host: hostValue, timers } = host({
    deadline: 4_000,
    createWidget: () => target.widget,
    slot: holder.slot,
  });
  const pending = promptWithDeadline(hostValue);
  assert.equal(target.calls.shown, 1);
  assert.deepEqual(holder.claimed, ["codex"]);
  assert.equal(timers[0].delayMs, 3_000);
  target.accept("chosen");
  assert.deepEqual(await pending, { value: "chosen", timedOut: false });
  assert.equal(timers[0].cancelled, true);
  assert.equal(target.calls.hidden, 1);
  assert.equal(target.calls.disposed, 1);
  assert.equal(target.calls.unsubscribed, 2);
  assert.equal(holder.current(), undefined);
});

test("a dismissal and a deadline both yield no value, and are told apart", async () => {
  // WHY THEY DIFFER. A user who closed the prompt answered it. A turn that ran out of time did
  // not, and the caller reports those two differently.
  const dismissed = widget();
  const { host: dismissHost } = host({
    deadline: 4_000,
    createWidget: () => dismissed.widget,
    slot: slot().slot,
  });
  const dismissal = promptWithDeadline(dismissHost);
  dismissed.hide();
  assert.deepEqual(await dismissal, { value: undefined, timedOut: false });

  const expired = widget();
  const { host: expireHost, timers } = host({
    deadline: 4_000,
    createWidget: () => expired.widget,
    slot: slot().slot,
  });
  const timing = promptWithDeadline(expireHost);
  timers[0].onDeadline();
  assert.deepEqual(await timing, { value: undefined, timedOut: true });
});

test("whatever arrives second is ignored, so a prompt never settles twice", async () => {
  const target = widget();
  const { host: hostValue, timers } = host({
    deadline: 4_000,
    createWidget: () => target.widget,
    slot: slot().slot,
  });
  const pending = promptWithDeadline(hostValue);
  target.accept("first");
  timers[0].onDeadline();
  target.hide();
  assert.deepEqual(await pending, { value: "first", timedOut: false });
  assert.equal(target.calls.disposed, 1);
});

test("an interrupt takes the prompt down through the slot it claimed", async () => {
  const target = widget();
  const holder = slot();
  const { host: hostValue } = host({
    deadline: 4_000,
    createWidget: () => target.widget,
    slot: holder.slot,
  });
  const pending = promptWithDeadline(hostValue);
  holder.current()();
  assert.deepEqual(await pending, { value: undefined, timedOut: false });
  assert.equal(target.calls.disposed, 1);
});

test("a prompt that has already been replaced does not clear its successor's claim", () => {
  // WHY IDENTITY. Release is by the cancel function that claimed the slot, so a late settle from
  // a superseded prompt cannot leave the live one uncancellable.
  const holder = slot();
  const first = () => {};
  const second = () => {};
  holder.slot.claim("codex", first);
  holder.slot.claim("codex", second);
  holder.slot.release(first);
  assert.equal(holder.current(), second);
  holder.slot.release(second);
  assert.equal(holder.current(), undefined);
});
