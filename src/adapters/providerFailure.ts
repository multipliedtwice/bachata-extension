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
  ["protocolError", /\bInvalid request\b|\bunknown variant\b|\bis no longer supported\b|\bdoes not speak the app-server protocol\b|\bcannot serialise exactly\b|\bdid not answer initialize\b/i, false],
  ["quotaExhausted", /\b(?:weekly|monthly|usage|message|token)\s+(?:limit|quota)\b|\bquota\s+(?:exhausted|reached)\b|\btry again (?:after|when).*(?:reset|limit)/i, false],
  ["rateLimited", /\brate[\s-]?limit(?:ed|ing)?\b|\btoo many requests\b|\b429\b|provider resource queue is full/i, true],
  ["authenticationRequired", /\b(?:sign|log)\s*in\b|\bauthentication required\b|\bsession expired\b|\bunauthori[sz]ed\b|\b401\b/i, false],
  ["timeout", /\btime(?:d)?\s*out\b|\bdeadline exceeded\b/i, true],
  ["interrupted", /\b(?:cancelled|canceled|interrupted|aborted)\b/i, true],
  ["providerUnavailable", /\b(?:service|provider)\s+unavailable\b|\btemporarily unavailable\b|\b502\b|\b503\b|\b504\b/i, true],
  ["protocolError", /\bprotocol\b.*\b(?:invalid|error|failed)\b|\bmalformed control\b/i, false],
];

export const classifyProviderFailure = (
  error: unknown,
  provider: string,
  resourceId: string,
  sideEffects: ProviderFailureSideEffects = "possible",
): ProviderFailure => {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown provider failure");
  for (const [code, pattern, retryable] of patterns) {
    if (pattern.test(message)) {
      return { code, message, provider, resourceId, retryable, sideEffects };
    }
  }
  return { code: "unknown", message, provider, resourceId, retryable: false, sideEffects };
};

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
