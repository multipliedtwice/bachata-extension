// A timeout is used two ways, and the tighter of the two limits has to win.
//
// As a deadline it becomes `new Date(now + timeoutMs).toISOString()`, which throws
// `RangeError: Invalid time value` past the 8.64e15 ms Date range. As a delay it reaches
// `setTimeout`, whose delay is a 32-bit signed integer of milliseconds: a larger value does
// not throw, it silently becomes a **1 ms** timer with a `TimeoutOverflowWarning`. A
// generous-looking ceiling therefore turns a long wait into an immediate one, which is worse
// than the crash it was meant to prevent.
//
// So the ceiling is Node's timer limit, 2^31 - 1 ms, about 24.8 days. It is below the Date
// range by four orders of magnitude and is the largest value that survives both uses intact.
export const MAXIMUM_TIMEOUT_MS = 2_147_483_647;
export const MINIMUM_TIMEOUT_MS = 1;

export const isSupportedTimeoutMs = (value: unknown): value is number =>
  typeof value === "number"
  && Number.isSafeInteger(value)
  && value >= MINIMUM_TIMEOUT_MS
  && value <= MAXIMUM_TIMEOUT_MS;

// Settings arrive from user configuration, which VS Code does not hard-clamp to a declared
// `minimum`/`maximum`. Reading through this keeps a hand-edited value from reaching a Date.
export const clampTimeoutMs = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < MINIMUM_TIMEOUT_MS) return MINIMUM_TIMEOUT_MS;
  if (rounded > MAXIMUM_TIMEOUT_MS) return MAXIMUM_TIMEOUT_MS;
  return rounded;
};

export const describeTimeoutBound = (): string =>
  `must be an integer between ${String(MINIMUM_TIMEOUT_MS)} and ${String(MAXIMUM_TIMEOUT_MS)} milliseconds`;

/**
 * Reads one timeout setting through the clamp. VS Code does not hard-clamp a hand-edited
 * `settings.json` to a declared `minimum`/`maximum`, so a raw `get<number>` hands whatever
 * is written there straight to `setTimeout` or to a `Date`. Every timeout read goes through
 * this, so the declaration and the runtime cannot disagree.
 */
export const readTimeoutSetting = (
  read: <T>(key: string, fallback: T) => T,
  key: string,
  fallback: number,
): number => clampTimeoutMs(read<number>(key, fallback), fallback);
