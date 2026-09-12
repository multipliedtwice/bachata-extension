export type ProviderFailureCode =
  | "quotaExhausted"
  | "rateLimited"
  | "authenticationRequired"
  | "providerUnavailable"
  | "timeout"
  | "interrupted"
  | "protocolError"
  | "scopeUnsupported"
  | "unknown";

export type ProviderFailureSideEffects = "none" | "possible" | "confirmed";

export type ProviderFailure = {
  code: ProviderFailureCode;
  message: string;
  provider: string;
  resourceId: string;
  retryable: boolean;
  sideEffects: ProviderFailureSideEffects;
  resetAt?: string;
  evidence?: string;
};

const patterns: Array<[ProviderFailureCode, RegExp, boolean]> = [
  ["scopeUnsupported", /\bhas no per-path readable-root capability\b/i, false],
  // A provider that says the installed client is too old is stating a permanent property of this
  // machine's installation, not a transient condition: retrying sends the same request to the same
  // binary. It is classified before the quota and authentication patterns because the sentence a
  // provider uses for it — "upgrade to the latest app or CLI and try again" — contains "try again",
  // which the quota pattern would otherwise claim.
  [
    "protocolError",
    /\brequires a newer version of\b|\bunsupported client version\b|\bclient version is (?:too old|unsupported)\b|\bupgrade to the latest (?:app|cli)\b|\bupgrade to the latest app or cli\b/i,
    false,
  ],
  ["protocolError", /\bInvalid request\b|\bunknown variant\b|\bis no longer supported\b|\bdoes not speak the app-server protocol\b|\bcannot serialise exactly\b|\bdid not answer initialize\b/i, false],
  ["quotaExhausted", /\b(?:weekly|monthly|usage|message|token)\s+(?:limit|quota)\b|\bquota\s+(?:exhausted|reached)\b|\btry again (?:after|when).*(?:reset|limit)/i, false],
  ["rateLimited", /\brate[\s-]?limit(?:ed|ing)?\b|\btoo many requests\b|\b429\b|provider resource queue is full/i, true],
  ["authenticationRequired", /\b(?:sign|log)\s*in\b|\bauthentication required\b|\bsession expired\b|\bunauthori[sz]ed\b|\b401\b/i, false],
  ["timeout", /\btime(?:d)?\s*out\b|\bdeadline exceeded\b/i, true],
  ["interrupted", /\b(?:cancelled|canceled|interrupted|aborted)\b/i, true],
  ["providerUnavailable", /\b(?:service|provider)\s+unavailable\b|\btemporarily unavailable\b|\b502\b|\b503\b|\b504\b/i, true],
  ["protocolError", /\bprotocol\b.*\b(?:invalid|error|failed)\b|\bmalformed control\b/i, false],
];

/**
 * How much of a provider's error text is worth parsing as JSON, and how deep into it to look.
 *
 * Both bounds exist because the text arrives from a process Bachata does not control. An envelope
 * larger than this is not an error report a human is meant to read, and a structure deeper than
 * this is not one a provider writes; refusing both keeps a hostile or corrupt payload from turning
 * error reporting into unbounded work.
 */
const MAXIMUM_ENVELOPE_LENGTH = 16_384;
const MAXIMUM_ENVELOPE_DEPTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseBoundedEnvelope = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAXIMUM_ENVELOPE_LENGTH) return undefined;
  const direct = ((): unknown => {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  })();
  if (direct !== undefined) return direct;
  // A provider often prefixes its envelope with its own prose. The outermost brace pair is the
  // only candidate worth trying: anything narrower is a fragment, and scanning for every possible
  // pair is the unbounded work the length cap exists to refuse.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

type EnvelopeCandidate = { message: string; depth: number; underError: boolean };

const collectEnvelopeMessages = (
  node: unknown,
  depth: number,
  underError: boolean,
  found: EnvelopeCandidate[],
): void => {
  if (depth > MAXIMUM_ENVELOPE_DEPTH) return;
  if (Array.isArray(node)) {
    node.forEach((entry) => { collectEnvelopeMessages(entry, depth + 1, underError, found); });
    return;
  }
  if (!isRecord(node)) return;
  const message = node.message;
  if (typeof message === "string" && message.trim().length > 0) {
    found.push({ message: message.trim(), depth, underError });
  }
  Object.entries(node).forEach(([key, value]) => {
    collectEnvelopeMessages(value, depth + 1, underError || key === "error", found);
  });
};

/**
 * The sentence a human should read out of a provider's JSON error envelope.
 *
 * Providers report a failure as `{"type":"error","status":400,"error":{"message":"..."}}`, and the
 * only part of that a reader can act on is the innermost `error.message`. Showing the envelope
 * instead puts wire framing in front of the one sentence that says what went wrong. A message
 * nested under `error` is preferred over a sibling at the same depth, because an envelope's own
 * top-level `message` is usually the generic one.
 *
 * Returns undefined when the text is not an envelope, which leaves the provider's own message
 * exactly as it arrived.
 */
export const extractProviderErrorMessage = (raw: string): string | undefined => {
  const parsed = parseBoundedEnvelope(raw);
  if (parsed === undefined) return undefined;
  const found: EnvelopeCandidate[] = [];
  collectEnvelopeMessages(parsed, 0, false, found);
  if (found.length === 0) return undefined;
  const best = found.reduce((winner, candidate) => {
    if (candidate.underError !== winner.underError) return candidate.underError ? candidate : winner;
    return candidate.depth > winner.depth ? candidate : winner;
  });
  return best.message === raw.trim() ? undefined : best.message;
};

export const classifyProviderFailure = (
  error: unknown,
  provider: string,
  resourceId: string,
  sideEffects: ProviderFailureSideEffects = "possible",
): ProviderFailure => {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown provider failure");
  // The envelope is kept as evidence rather than discarded: the readable sentence is what the
  // primary result shows, and the wire form is what a reader needs when they have to report the
  // failure to the provider.
  const extracted = extractProviderErrorMessage(raw);
  const message = extracted ?? raw;
  const evidence = extracted === undefined ? {} : { evidence: raw };
  for (const [code, pattern, retryable] of patterns) {
    if (pattern.test(message)) {
      return { code, message, provider, resourceId, retryable, sideEffects, ...evidence };
    }
  }
  return { code: "unknown", message, provider, resourceId, retryable: false, sideEffects, ...evidence };
};

/**
 * Whether the provider refused because the installed client is older than the request needs.
 *
 * It is a protocol failure like any other rejection, but its remedy is specific — a newer
 * executable, not a different setting — so the recovery offered for it says so.
 */
export const isClientVersionFailure = (failure: ProviderFailure): boolean =>
  failure.code === "protocolError" &&
  /\brequires a newer version of\b|\bunsupported client version\b|\bclient version is (?:too old|unsupported)\b|\bupgrade to the latest (?:app|cli)\b/i.test(
    failure.message,
  );

export const providerFailureRequiresHumanChoice = (failure: ProviderFailure): boolean =>
  failure.code === "protocolError" || failure.code === "scopeUnsupported";

export const shouldOpenProviderResourceCircuit = (failure: ProviderFailure): boolean =>
  failure.code === "quotaExhausted" || failure.code === "authenticationRequired";

// A protocol rejection or a refused read scope is a property of the installed provider, not a
// transient condition, so Bachata never answers one by silently running the work somewhere else.
export const providerFallbackFailureCodes: ReadonlySet<ProviderFailureCode> = new Set<ProviderFailureCode>([
  "quotaExhausted",
  "rateLimited",
  "authenticationRequired",
  "providerUnavailable",
  "timeout",
]);

export const providerFailureErrorIfRecognized = (
  error: unknown,
  provider: string,
  resourceId: string,
  sideEffects: ProviderFailureSideEffects,
): unknown => {
  if (error instanceof ProviderFailureError) {
    return error;
  }
  const failure = classifyProviderFailure(error, provider, resourceId, sideEffects);
  return providerFallbackFailureCodes.has(failure.code) || providerFailureRequiresHumanChoice(failure)
    ? new ProviderFailureError(failure, error)
    : error;
};

export class ProviderFailureError extends Error {
  readonly failure: ProviderFailure;

  constructor(failure: ProviderFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = "ProviderFailureError";
    this.failure = failure;
  }
}

export const isProviderFailureError = (value: unknown): value is ProviderFailureError =>
  value instanceof ProviderFailureError;

export const isProviderFailure = (value: unknown): value is ProviderFailure => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.code === "string"
    && typeof record.message === "string"
    && typeof record.provider === "string"
    && typeof record.resourceId === "string"
    && typeof record.retryable === "boolean";
};
