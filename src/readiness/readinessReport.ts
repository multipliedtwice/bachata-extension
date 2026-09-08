/**
 * EX-3. What a readiness probe means and how the report is assembled, apart from probing.
 *
 * Readiness runs three provider probes and two Git commands. Around them sat rules that are not
 * probes at all: what an unreachable provider is reported as, whether a recorded runtime version
 * survives a failed probe, which pipelines a report covers when the caller named none, and which
 * of a pipeline's per-pipeline facts are omitted rather than guessed when the catalog does not
 * have it. Each was reachable only by running the probes.
 *
 * `gitReadinessFrom` in `gitReadiness.ts` decides the Git half the same way; this composes with it
 * rather than absorbing it.
 */
export type AdapterProbeReadiness = {
  type: string;
  available: boolean;
  detail: string;
};

export type ProviderProbeOutcome =
  /** The provider needs a token the environment does not carry, so nothing was run. */
  | { outcome: "missingToken"; tokenVariable: string; endpoint: string }
  /** The command ran and named its version. */
  | { outcome: "version"; command: string; version: string }
  /** The command was run and did not answer. */
  | { outcome: "failed"; command: string; error: unknown };

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What one provider probe is reported as, and the version the report may keep.
 *
 * A probe that did not answer clears the recorded version rather than leaving the last good one
 * standing: a version nobody just confirmed is a claim about a provider that may no longer be
 * installed, and every downstream contract reads these as current.
 */
export const providerReadinessFrom = (
  type: string,
  probe: ProviderProbeOutcome,
): { readiness: AdapterProbeReadiness; version?: string } => {
  if (probe.outcome === "version") {
    return {
      readiness: { type, available: true, detail: `${probe.command}: ${probe.version}` },
      version: probe.version,
    };
  }
  if (probe.outcome === "missingToken") {
    return {
      readiness: {
        type,
        available: false,
        detail: `${probe.tokenVariable} is not set, so Bachata cannot reach ${probe.endpoint}`,
      },
    };
  }
  return {
    readiness: {
      type,
      available: false,
      detail: `${probe.command} unavailable: ${errorText(probe.error)}`,
    },
  };
};

/** The recorded versions after a probe: set when one answered, dropped when none did. */
export const providerVersionsAfter = (
  versions: Readonly<Record<string, string>>,
  type: string,
  version: string | undefined,
): Record<string, string> => {
  if (version !== undefined) return { ...versions, [type]: version };
  const kept = { ...versions };
  delete kept[type];
  return kept;
};

/**
 * Which pipelines a report covers. A caller that named none is asking about the whole catalog; a
 * caller that named the same pipeline twice is asking about it once.
 */
export const requestedPipelineIds = (
  requested: readonly string[] | undefined,
  known: Iterable<string>,
): string[] =>
  requested !== undefined && requested.length > 0
    ? Array.from(new Set(requested))
    : Array.from(known);

/** The providers a pipeline needs, named once each and in a stable order. */
export const pipelineProviderIndex = (
  pipelines: Iterable<{ id: string; agents: readonly { adapter: string }[] }>,
): Record<string, string[]> =>
  Object.fromEntries(
    Array.from(pipelines).map((pipeline) => [
      pipeline.id,
      Array.from(new Set(pipeline.agents.map((agent) => agent.adapter))).sort(),
    ]),
  );

export const pipelineNameIndex = (
  summaries: Iterable<{ id: string; name: string }>,
): Record<string, string> =>
  Object.fromEntries(Array.from(summaries).map((pipeline) => [pipeline.id, pipeline.name]));

/**
 * The per-pipeline facts, keyed by pipeline.
 *
 * A requested pipeline the catalog does not have still gets a readiness entry — the caller asked
 * about it and is owed an answer — but no safety level and no guardrail summary, because both are
 * read off a definition that is not there. Omitted, never defaulted: a guardrail summary invented
 * for a missing pipeline would read as a checked one.
 */
export const pipelineFactIndexes = <Safety, Guardrail>(
  entries: readonly {
    pipelineId: string;
    safetyLevel?: Safety | undefined;
    guardrails?: Guardrail | undefined;
  }[],
): { safetyLevels: Record<string, Safety>; guardrails: Record<string, Guardrail> } => {
  const safetyLevels: Record<string, Safety> = {};
  const guardrails: Record<string, Guardrail> = {};
  for (const entry of entries) {
    if (entry.safetyLevel !== undefined) safetyLevels[entry.pipelineId] = entry.safetyLevel;
    if (entry.guardrails !== undefined) guardrails[entry.pipelineId] = entry.guardrails;
  }
  return { safetyLevels, guardrails };
};
