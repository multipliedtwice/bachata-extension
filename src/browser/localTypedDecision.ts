export type TypedDecisionCandidate = Readonly<{
  id: string;
  kindHint: string;
  evidence: string;
}>;

export type TypedDecision = {
  execute: string[];
  reject: string[];
  ambiguous: string[];
};

export type TypedDecisionAdapter = (
  candidates: readonly TypedDecisionCandidate[],
  signal: AbortSignal,
) => Promise<unknown>;

export const TYPED_DECISION_LIMITS = Object.freeze({
  candidates: 16,
  evidenceBytes: 2_048,
  inputBytes: 8_192,
  timeoutMs: 250,
});

export const TYPED_DECISION_OUTCOMES = Object.freeze(["execute", "reject", "ambiguous"] as const);

const readOnlyKinds = new Set(["read", "search", "list", "dependencies", "dependents"]);
const activeAdapters = new WeakSet<TypedDecisionAdapter>();
const encoder = new TextEncoder();

export const closedDecisionRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null)
      && Reflect.ownKeys(value).length === keys.length
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
      });
  } catch {
    return false;
  }
};

export const projectTypedDecisionCandidates = (
  candidates: readonly TypedDecisionCandidate[],
): readonly TypedDecisionCandidate[] | undefined => {
  if (!Array.isArray(candidates) || candidates.length === 0
    || candidates.length > TYPED_DECISION_LIMITS.candidates) return undefined;
  const ids = new Set<string>();
  const projected: TypedDecisionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== "string"
      || !/^[a-z][a-z0-9_-]{0,63}$/u.test(candidate.id)
      || candidate.id === "constructor" || candidate.id === "prototype"
      || ids.has(candidate.id) || !readOnlyKinds.has(candidate.kindHint)
      || typeof candidate.evidence !== "string" || candidate.evidence.trim().length === 0
      || candidate.evidence.length > TYPED_DECISION_LIMITS.evidenceBytes
      || encoder.encode(candidate.evidence).length > TYPED_DECISION_LIMITS.evidenceBytes
      || !candidate.evidence.isWellFormed()) return undefined;
    ids.add(candidate.id);
    projected.push(Object.freeze({ id: candidate.id, kindHint: candidate.kindHint, evidence: candidate.evidence }));
  }
  if (encoder.encode(JSON.stringify(projected)).length > TYPED_DECISION_LIMITS.inputBytes) return undefined;
  return Object.freeze(projected);
};

const readCompleteDecision = (
  value: unknown,
  candidates: readonly TypedDecisionCandidate[],
): TypedDecision | undefined => {
  if (!closedDecisionRecord(value, TYPED_DECISION_OUTCOMES)) return undefined;
  const valid = new Set(candidates.map((candidate) => candidate.id));
  const seen = new Set<string>();
  const result: TypedDecision = { execute: [], reject: [], ambiguous: [] };
  for (const outcome of TYPED_DECISION_OUTCOMES) {
    const ids = value[outcome];
    if (!Array.isArray(ids) || ids.length > valid.size) return undefined;
    for (const id of ids) {
      if (typeof id !== "string" || !valid.has(id) || seen.has(id)) return undefined;
      seen.add(id);
      result[outcome].push(id);
    }
  }
  return seen.size === valid.size && result.ambiguous.length === 0 ? result : undefined;
};

export const tryTypedDecision = async (
  candidates: readonly TypedDecisionCandidate[],
  adapter?: TypedDecisionAdapter,
  signal?: AbortSignal,
  timeoutMs: number = TYPED_DECISION_LIMITS.timeoutMs,
): Promise<TypedDecision | undefined> => {
  if (signal?.aborted) throw new Error("Local model request interrupted");
  if (!adapter || activeAdapters.has(adapter)
    || !Number.isFinite(timeoutMs) || timeoutMs < 1
    || timeoutMs > TYPED_DECISION_LIMITS.timeoutMs) return undefined;
  const projected = projectTypedDecisionCandidates(candidates);
  if (!projected) return undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const started = performance.now();
  let stopped: () => void = () => undefined;
  const interrupted = new Promise<undefined>((resolve) => {
    stopped = (): void => resolve(undefined);
    controller.signal.addEventListener("abort", stopped, { once: true });
  });
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  activeAdapters.add(adapter);
  const pending = Promise.resolve().then(async () => {
    if (controller.signal.aborted) return undefined;
    return readCompleteDecision(await adapter(projected, controller.signal), projected);
  }).catch(() => undefined).finally(() => activeAdapters.delete(adapter));
  try {
    const decision = await Promise.race([pending, interrupted]);
    if (signal?.aborted) throw new Error("Local model request interrupted");
    return controller.signal.aborted || performance.now() - started >= timeoutMs ? undefined : decision;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stopped);
    controller.abort();
  }
};
