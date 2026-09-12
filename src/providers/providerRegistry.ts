/**
 * One extension host, one answer about which providers are installed.
 *
 * Provider availability is a property of the machine, not of a pipeline: whether `codex` is
 * installed does not change because a different pipeline was selected, because a role was pointed
 * at a different CLI, or because a second conversation was opened. Discovery therefore runs once at
 * startup, keyed by what actually identifies a provider — its adapter type, the executable that
 * answers for it, and the directory it would run in — and every conversation, pipeline and role
 * reads the same records.
 *
 * That key is also what fixes assignment. A reassigned role resolves to a provider identity the
 * startup pass already discovered, so pointing Lead at Claude finds Claude's record rather than
 * asking the machine again; a probe per assignment is not an optimisation this avoids, it is a
 * question that was already answered.
 *
 * Three states are distinct on purpose. `unknown` means nobody has looked, `discovering` means a
 * pass is in flight, and only `unavailable` means the machine was asked and said no. Collapsing the
 * first two into the third is what makes a freshly opened window claim every provider is missing.
 */
import type { ProviderProbeOutcome } from "../readiness/readinessReport";

export type ProviderDiscoveryState = "unknown" | "discovering" | "available" | "unavailable";

export type ProviderIdentity = {
  adapterType: string;
  command: string;
  workingDirectory: string;
  /**
   * What else about the request would change the answer, where anything does.
   *
   * Two consumers may name the same backend at the same address and still not be asking the same
   * question: one may be authenticated and the other not, one may be allowed off the loopback and
   * the other not, and they may allow the server different amounts of time. A record discovered
   * under one of those must not answer for the other, so whatever distinguishes them is part of
   * the identity. It carries no secret — the name of a credential's source at most, never its
   * value.
   */
  requestScope?: string | undefined;
};

/**
 * A model as the provider itself described it. Deliberately provider-agnostic: an id, whether it can
 * answer now, and whatever capabilities the provider chose to report. Nothing is inferred from the
 * name — a model's brand is not a capability.
 */
export type ProviderModel = {
  id: string;
  availability?: "loaded" | "installed";
  capabilities?: string[];
  family?: string;
  parameterSize?: string;
  quantization?: string;
};

export type ProviderRecord = ProviderIdentity & {
  state: ProviderDiscoveryState;
  version?: string;
  /**
   * Models the provider itself reported. Absent means the provider exposes no model listing this
   * build knows how to ask for — which is not the same as a provider that offers no models, and is
   * never presented as one.
   */
  models?: ProviderModel[];
  detail?: string;
  checkedAt?: string;
};

/** What identifies a provider, and therefore what a cached answer is an answer about. */
export const providerKey = (identity: ProviderIdentity): string =>
  JSON.stringify([
    identity.adapterType,
    identity.command,
    identity.workingDirectory,
    identity.requestScope ?? "",
  ]);

export type ProviderRegistry = {
  /**
   * Discover every identity not already answered. Identities already available, already
   * unavailable, or already in flight are not asked again, so calling this on every window, every
   * conversation and every assignment costs one pass in total.
   */
  discover: (identities: readonly ProviderIdentity[]) => Promise<void>;
  /** Ask the machine again for these identities whatever is cached. */
  refresh: (identities: readonly ProviderIdentity[]) => Promise<void>;
  record: (identity: ProviderIdentity) => ProviderRecord;
  records: () => ProviderRecord[];
  /**
   * Drop the cached answer for every record the predicate names, so the next discovery asks again.
   * Returns the keys it dropped, which is what lets a caller refresh exactly those and no more.
   */
  invalidate: (matches: (record: ProviderRecord) => boolean) => ProviderIdentity[];
  /**
   * Record an answer someone else already obtained — the manual availability check runs the
   * provider through its adapter and learns the same fact, and letting that answer replace the
   * shared one is what stops one conversation believing something the others do not.
   */
  adopt: (identity: ProviderIdentity, outcome: ProviderProbeOutcome) => void;
  /** Whether any discovery pass is in flight, for the editor's temporary state. */
  discovering: () => boolean;
  /** How many probes have actually been run, which is what proves a pass was not repeated. */
  probeCount: () => number;
  subscribe: (listener: () => void) => { dispose: () => void };
};

/**
 * One probe's claim on a key. The record itself is the ownership token: a probe owns its key while
 * and only while this exact object is the one the in-flight map holds for it, so retirement needs
 * no counter, and two probes for one key can never be mistaken for each other.
 */
type InFlightProbe = { promise: Promise<void> };

const unknownRecord = (identity: ProviderIdentity): ProviderRecord => ({
  ...identity,
  state: "unknown",
});

const probeDetail = (outcome: ProviderProbeOutcome): string =>
  outcome.outcome === "version"
    ? `${outcome.command}: ${outcome.version}`
    : outcome.outcome === "missingToken"
      ? `${outcome.tokenVariable} is not set, so Bachata cannot reach ${outcome.endpoint}`
      : `${outcome.command} did not answer: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;

/** The record an answered probe becomes, whoever obtained the answer. */
const settledRecord = (
  identity: ProviderIdentity,
  outcome: ProviderProbeOutcome,
  models: ProviderModel[] | undefined,
  checkedAt: string,
): ProviderRecord => ({
  ...identity,
  state: outcome.outcome === "version" ? "available" : "unavailable",
  ...(outcome.outcome === "version" ? { version: outcome.version } : {}),
  ...(models === undefined ? {} : { models }),
  detail: probeDetail(outcome),
  checkedAt,
});

export const createProviderRegistry = (input: {
  probe: (identity: ProviderIdentity) => Promise<ProviderProbeOutcome>;
  /** Supplied only for providers with a documented listing mechanism; absent leaves models unset. */
  probeModels?: (identity: ProviderIdentity, outcome: ProviderProbeOutcome) => Promise<ProviderModel[] | undefined>;
  now?: () => string;
  log?: (message: string) => void;
}): ProviderRegistry => {
  const now = input.now ?? (() => new Date().toISOString());
  const records = new Map<string, ProviderRecord>();
  /**
   * The probe that currently owns each key, and nothing else.
   *
   * A probe used to be identified by the key it answers for, which is not an identity: dropping a
   * key's cached answer left its probe in this map, so the rediscovery that a configuration change
   * exists to trigger found the retired probe, waited for it, and published the answer it had
   * earned under the previous configuration — and then deleted an entry that by that point belonged
   * to newer work. So each probe carries its own ownership token, it is the owner only while this
   * map still holds it, and retirement is removal: a retired probe may finish, but it publishes
   * nothing, announces nothing, evicts nobody, and no longer stands in the way of asking again.
   */
  const inFlight = new Map<string, InFlightProbe>();
  const listeners = new Set<() => void>();
  let probeCount = 0;

  const announce = (): void => {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        input.log?.(
          `A provider registry listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };

  /** Remove a key's current owner, so a late answer cannot land and a new probe may start. */
  const retire = (key: string): void => {
    inFlight.delete(key);
  };

  const runProbe = (identity: ProviderIdentity): Promise<void> => {
    const key = providerKey(identity);
    const existing = inFlight.get(key);
    // Two conversations opening at once ask the same question; they wait on one answer rather than
    // starting a second process to learn the same thing.
    if (existing) {
      return existing.promise;
    }
    const owner: InFlightProbe = { promise: Promise.resolve() };
    const owns = (): boolean => inFlight.get(key) === owner;
    records.set(key, { ...unknownRecord(identity), state: "discovering" });
    inFlight.set(key, owner);
    announce();
    owner.promise = (async () => {
      probeCount += 1;
      let outcome: ProviderProbeOutcome;
      try {
        outcome = await input.probe(identity);
      } catch (error) {
        outcome = { outcome: "failed", command: identity.command, error };
      }
      const models = await (async () => {
        if (!input.probeModels || outcome.outcome !== "version") {
          return undefined;
        }
        try {
          return await input.probeModels(identity, outcome);
        } catch (error) {
          input.log?.(
            `Model discovery for ${identity.adapterType} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
      })();
      // The answer to a question nobody is asking any more is not an answer about anything this
      // registry holds: an adopted record, a newer probe's record, or a deliberately dropped one
      // would all be overwritten by it.
      if (owns()) {
        records.set(key, settledRecord(identity, outcome, models, now()));
      }
    })().finally(() => {
      if (!owns()) {
        return;
      }
      retire(key);
      announce();
    });
    return owner.promise;
  };

  const settled = (identity: ProviderIdentity): boolean => {
    const state = records.get(providerKey(identity))?.state;
    return state === "available" || state === "unavailable";
  };

  return {
    discover: async (identities) => {
      await Promise.all(
        identities.filter((identity) => !settled(identity)).map(runProbe),
      );
    },
    refresh: async (identities) => {
      // A probe already running is answering the question as it was asked before; a refresh is the
      // caller saying that question is stale. It is retired rather than awaited, so what this
      // returns is the answer to the refresh and not to whatever it interrupted.
      identities.forEach((identity) => {
        const key = providerKey(identity);
        retire(key);
        records.delete(key);
      });
      await Promise.all(identities.map(runProbe));
    },
    record: (identity) => records.get(providerKey(identity)) ?? unknownRecord(identity),
    records: () => Array.from(records.values()).map((record) => ({ ...record })),
    invalidate: (matches) => {
      const dropped: ProviderIdentity[] = [];
      Array.from(records.entries()).forEach(([key, record]) => {
        if (!matches(record)) {
          return;
        }
        records.delete(key);
        retire(key);
        dropped.push({
          adapterType: record.adapterType,
          command: record.command,
          workingDirectory: record.workingDirectory,
          // Dropped too, and then the caller refreshed a different key: the request scope is part
          // of what the record answers for, so an identity rebuilt without it is an identity for
          // a question nobody asked.
          ...(record.requestScope === undefined ? {} : { requestScope: record.requestScope }),
        });
      });
      if (dropped.length > 0) {
        announce();
      }
      return dropped;
    },
    adopt: (identity, outcome) => {
      const key = providerKey(identity);
      // A probe already in flight is about to write its own answer; letting an adopted one land
      // first would be overwritten a moment later and read as a flicker.
      if (inFlight.has(key)) {
        return;
      }
      const models = records.get(key)?.models;
      records.set(key, settledRecord(identity, outcome, models, now()));
      announce();
    },
    discovering: () => inFlight.size > 0,
    probeCount: () => probeCount,
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
};
