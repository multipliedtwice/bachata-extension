/**
 * One resolved local-interpreter configuration for the whole host.
 *
 * The extension interprets browser output on one side and the bridge heals selectors on the other,
 * and until now each decided for itself which backend and model to use. Two decisions made from the
 * same settings can still disagree — one falls back to LM Studio while the other reaches Ollama —
 * and then a reader is told the interpreter is ready by one half and unavailable by the other. So
 * the decision is made once, here, and both halves are handed the result.
 *
 * Readiness is cached the same way provider availability is: discovered from the shared registry's
 * records, refreshed only when something says it changed, and never repeated because a role was
 * reassigned or a conversation was opened.
 */
import {
  CONTRACT_PROBE_PROMPT,
  LOCAL_BACKENDS,
  contractIdentityRefusal,
  LocalBackendProbe,
  LocalModelBackendId,
  LocalModelSelection,
  LocalModelSummary,
  contractProbeVerdict,
  localBackendForAdapterType,
  normalizeEndpoint,
  selectLocalModel,
} from "./localModelDiscovery";
import { providerKey } from "./providerRegistry";
import type { ProviderIdentity, ProviderRecord, ProviderRegistry } from "./providerRegistry";
import { parseLocalDecision } from "../browser/localInterpretation";

/**
 * One consumer's own settings.
 *
 * Selector healing and semantic interpretation are configured separately, and they are allowed to
 * disagree: a reader may heal selectors with a small model on one server and interpret pages with a
 * larger one on another. Reading a backend and endpoint from one of them and a model name from the
 * other produced a tuple nobody configured, and then verified that tuple on behalf of both.
 */
export type LocalConsumerSettings = {
  enabled: boolean;
  backend: "auto" | LocalModelBackendId;
  endpoint: string;
  model: string;
  /**
   * How long this consumer's own requests may take. Discovery and the contract check are this
   * consumer's requests, so they are bounded by this rather than by whatever the other consumer's
   * setting happened to say.
   */
  timeoutMs: number;
  /**
   * Whether this consumer may be pointed at an address that is not loopback. Only semantic
   * interpretation documents such an opt-in; selector healing is loopback-only and passes `false`,
   * so a remote opt-in can never travel to the bridge through a shared decision.
   */
  allowRemote: boolean;
  /**
   * The environment variable a remote endpoint's bearer token is read from, and the value read from
   * it. The name identifies the configuration; the value is used to make a request and is never
   * logged, persisted, rendered, or put in a cache key.
   */
  apiKeyEnvironment: string;
  apiKey?: string | undefined;
};

/**
 * One consumer's request as the network sees it: where it goes, how long it may take, whether it
 * may leave the machine, and what it authenticates with.
 */
export type LocalRequestConfig = {
  backend: LocalModelBackendId;
  endpoint: string;
  model: string;
  timeoutMs: number;
  allowRemote: boolean;
  apiKey?: string | undefined;
};

/**
 * What makes two requests the same question.
 *
 * Everything that changes what the server is asked, or what it is allowed to be asked, belongs
 * here: a verdict earned with a credential does not vouch for the same model unauthenticated, and
 * one earned with a generous timeout does not vouch for a consumer that allows a second. The
 * credential contributes the name of its source and whether the environment carried a value —
 * never the value, which is why this string is safe to use as a cache key and to keep in a
 * provider identity.
 */
export const localRequestScope = (consumer: {
  timeoutMs: number;
  allowRemote: boolean;
  apiKeyEnvironment: string;
  apiKey?: string | undefined;
}): string =>
  JSON.stringify([
    consumer.timeoutMs,
    consumer.allowRemote,
    consumer.apiKeyEnvironment,
    consumer.apiKey ? "authenticated" : "anonymous",
  ]);

/** The two features that can ask a local model to interpret something. */
export type LocalConsumerId = "semanticInterpreter" | "selectorHealing";

export const LOCAL_CONSUMERS: readonly LocalConsumerId[] = ["semanticInterpreter", "selectorHealing"];

export type LocalModelSettings = {
  consumers: Record<LocalConsumerId, LocalConsumerSettings>;
};

/**
 * The identities one consumer's settings ask about. A reader who names an endpoint gets exactly that
 * one asked; otherwise both documented defaults are, because either may be the one running and
 * asking is cheaper than making the reader tell us.
 *
 * A consumer that is off asks nothing. Returning identities anyway made activation knock on
 * 127.0.0.1 whether or not the feature was on, and — on a machine where a server answered — let the
 * readiness check that follows discovery load a multi-gigabyte model nobody had enabled.
 */
export const consumerBackendIdentities = (
  consumer: LocalConsumerSettings,
): ProviderIdentity[] => {
  if (!consumer.enabled) {
    return [];
  }
  const endpoint = normalizeEndpoint(consumer.endpoint);
  const backends = consumer.backend === "auto"
    ? LOCAL_BACKENDS
    : LOCAL_BACKENDS.filter((backend) => backend.id === consumer.backend);
  const requestScope = localRequestScope(consumer);
  return backends.map((backend) => ({
    adapterType: backend.adapterType,
    command: endpoint || backend.defaultEndpoint,
    workingDirectory: "",
    requestScope,
  }));
};

/**
 * One backend the host has to ask about, and the request policy it must be asked under.
 *
 * Discovery is a network call with the same reach, the same credential and the same deadline as
 * the interpretation that follows it. Asking under a different policy — a fixed timeout, no
 * credential, loopback only — meant a documented remote endpoint could never be discovered however
 * it was configured, and that a reader who opted in was still refused.
 */
export type LocalBackendRequest = {
  identity: ProviderIdentity;
  policy: { timeoutMs: number; allowRemote: boolean; apiKey?: string | undefined };
};

const requestPolicy = (consumer: LocalConsumerSettings): LocalBackendRequest["policy"] => ({
  timeoutMs: consumer.timeoutMs,
  allowRemote: consumer.allowRemote,
  ...(consumer.apiKey === undefined ? {} : { apiKey: consumer.apiKey }),
});

/**
 * Every backend request the enabled consumers ask for, each distinct one named once. Two consumers
 * asking the identical question share one record and one probe; two that differ in endpoint,
 * authentication, remote policy or timeout get one each, because neither may read the other's
 * answer.
 */
export const localBackendRequests = (settings: LocalModelSettings): LocalBackendRequest[] => {
  const seen = new Set<string>();
  return LOCAL_CONSUMERS.flatMap((consumer) => {
    const configured = settings.consumers[consumer];
    return consumerBackendIdentities(configured).map((identity) => ({
      identity,
      policy: requestPolicy(configured),
    }));
  }).flatMap((request) => {
    const key = providerKey(request.identity);
    if (seen.has(key)) return [];
    seen.add(key);
    return [request];
  });
};

/**
 * Every identity the host discovers for local backends: the union of what the enabled consumers ask
 * about, each named once. Two consumers pointing at the same server share one record and one probe;
 * two pointing at different servers get one each.
 */
export const localBackendIdentities = (settings: LocalModelSettings): ProviderIdentity[] =>
  localBackendRequests(settings).map((request) => request.identity);

/**
 * A registry record read back as a backend probe. `unknown` and `discovering` are deliberately not
 * probes at all: a backend nobody has finished asking about is not a backend that answered no.
 */
export const probeFromRecord = (record: ProviderRecord): LocalBackendProbe | undefined => {
  const backend = localBackendForAdapterType(record.adapterType);
  if (!backend || record.state === "unknown" || record.state === "discovering") {
    return undefined;
  }
  return {
    backend: backend.id,
    endpoint: record.command,
    reachable: record.state === "available",
    models: (record.models ?? []).map((model) => ({
      id: model.id,
      backend: backend.id,
      availability: model.availability ?? "loaded",
      ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
      ...(model.family === undefined ? {} : { family: model.family }),
      ...(model.parameterSize === undefined ? {} : { parameterSize: model.parameterSize }),
      ...(model.quantization === undefined ? {} : { quantization: model.quantization }),
    })),
    detail: record.detail ?? `${backend.label} at ${record.command}`,
  };
};

export type LocalModelReadiness = {
  enabled: boolean;
  selection: LocalModelSelection;
  /** Every backend the host has finished asking about, for the settings view. */
  probes: LocalBackendProbe[];
  discovering: boolean;
};

export type ContractCheckKey = string;

/**
 * What a recorded verdict is a verdict about. The tuple that ran, plus the request scope it ran
 * under, so an answer earned with one credential, reach or deadline never vouches for a consumer
 * configured with another.
 */
export const contractCheckKey = (
  backend: LocalModelBackendId,
  endpoint: string,
  model: string,
  scope = "",
): ContractCheckKey => `${backend}|${normalizeEndpoint(endpoint)}|${model}|${scope}`;

export type LocalModelService = {
  /** Ask the shared registry to discover the configured backends; already-answered ones cost nothing. */
  discover: () => Promise<void>;
  /**
   * What one consumer is told. Omitting the consumer answers for the host as a whole — the enabled
   * consumer whose state a reader is shown in the Agents view — which is a summary, not something a
   * caller may run on.
   */
  readiness: (consumer?: LocalConsumerId) => LocalModelReadiness;
  /**
   * The configuration one consumer may run on: its own backend, its own normalized endpoint and a
   * model verified on exactly that pair. Absent when nothing is ready, so a caller cannot
   * accidentally run on a model the host never confirmed for the server it is about to ask.
   */
  resolvedConfig: (
    consumer: LocalConsumerId,
  ) => { backend: LocalModelBackendId; endpoint: string; model: string } | undefined;
  /**
   * Run the bounded contract check for whatever each enabled consumer currently proposes, and
   * remember the verdicts. A tuple already judged is not judged again, so two consumers pointing at
   * the same backend, endpoint and model share one check.
   */
  verifySelection: (signal?: AbortSignal) => Promise<void>;
  /** Forget cached readiness — a settings change, a backend event, or a real request failure. */
  invalidate: () => void;
};

const disabledReadiness = (): LocalModelReadiness => ({
  enabled: false,
  selection: {
    status: "serverUnavailable",
    detail: "Local interpretation is off",
  },
  probes: [],
  discovering: false,
});

export const createLocalModelService = (input: {
  registry: ProviderRegistry;
  settings: () => LocalModelSettings;
  /**
   * Runs one interpreter prompt against a named backend and model.
   *
   * A transport that can say which model answered returns it beside the text; one that cannot
   * returns the text alone, and the gate then stands on the answer as it always did.
   */
  runPrompt: (
    target: LocalRequestConfig,
    prompt: string,
    signal?: AbortSignal,
  ) => Promise<string | { text: string; model?: string | undefined }>;
  log?: (message: string) => void;
}): LocalModelService => {
  // Keyed by backend, endpoint and model together, so a verdict earned on one server never vouches
  // for the same model name on another.
  const verdicts = new Map<ContractCheckKey, boolean>();
  // What configuration the verdicts belong to. A check that was in flight when the settings changed
  // is answering an obsolete question, and its answer is dropped rather than published.
  let generation = 0;
  let verifying: Promise<void> | undefined;
  let verifyAbort: AbortController | undefined;

  const consumerSettings = (consumer: LocalConsumerId): LocalConsumerSettings =>
    input.settings().consumers[consumer];

  const probesFor = (consumer: LocalConsumerId): LocalBackendProbe[] =>
    consumerBackendIdentities(consumerSettings(consumer))
      .map((identity) => input.registry.record(identity))
      .flatMap((record) => {
        const probe = probeFromRecord(record);
        return probe ? [probe] : [];
      });

  const scopeFor = (consumer: LocalConsumerId): string =>
    localRequestScope(consumerSettings(consumer));

  const checkKey = (consumer: LocalConsumerId, model: LocalModelSummary, endpoint: string) =>
    contractCheckKey(model.backend, endpoint, model.id, scopeFor(consumer));

  const verdictFor = (
    consumer: LocalConsumerId,
  ): ((model: LocalModelSummary, endpoint: string) => boolean | undefined) =>
    (model, endpoint) => verdicts.get(checkKey(consumer, model, endpoint));

  const selectionFor = (
    consumer: LocalConsumerId,
    skip?: (model: LocalModelSummary, endpoint: string) => boolean,
  ): LocalModelSelection => {
    const settings = consumerSettings(consumer);
    return selectLocalModel({
      probes: probesFor(consumer),
      explicitModel: settings.model.trim() || undefined,
      explicitBackend: settings.backend,
      contractVerdict: verdictFor(consumer),
      ...(skip === undefined ? {} : { skip }),
    });
  };

  const readinessFor = (consumer: LocalConsumerId): LocalModelReadiness => {
    const settings = consumerSettings(consumer);
    if (!settings.enabled) {
      return disabledReadiness();
    }
    return {
      enabled: true,
      selection: selectionFor(consumer),
      probes: probesFor(consumer),
      discovering: consumerBackendIdentities(settings).some(
        (identity) => input.registry.record(identity).state === "discovering",
      ),
    };
  };

  const readiness = (consumer?: LocalConsumerId): LocalModelReadiness => {
    if (consumer !== undefined) {
      return readinessFor(consumer);
    }
    const shown = LOCAL_CONSUMERS.find((candidate) => consumerSettings(candidate).enabled);
    return shown === undefined ? disabledReadiness() : readinessFor(shown);
  };

  /**
   * Judge one consumer's proposal, and the next one after that, until a model is proven, none can be
   * reached, or every candidate has been judged. A failed model is not the end of the search:
   * stopping at the first refusal ended startup "unverified" whenever the top-ranked model happened
   * to be the one that could not do the job.
   */
  const verifyConsumer = async (
    consumer: LocalConsumerId,
    ownGeneration: number,
    signal: AbortSignal,
    // Candidates whose check could not be completed are passed over for the rest of this pass, so
    // the search moves on instead of being handed the same model again. Shared across consumers:
    // two consumers pointing at the same backend, endpoint and model are one question, and asking
    // it twice spends a reader's machine on an answer already given.
    attempted: Set<ContractCheckKey>,
  ): Promise<void> => {
    if (!consumerSettings(consumer).enabled) {
      return;
    }
    for (;;) {
      if (signal.aborted || generation !== ownGeneration) {
        return;
      }
      const settings = consumerSettings(consumer);
      const selection = selectionFor(consumer, (model, endpoint) =>
        attempted.has(checkKey(consumer, model, endpoint)));
      if (selection.status !== "unverified") {
        return;
      }
      const key = contractCheckKey(
        selection.backend,
        selection.endpoint,
        selection.model.id,
        scopeFor(consumer),
      );
      if (verdicts.has(key) || attempted.has(key)) {
        return;
      }
      attempted.add(key);
      try {
        const answer = await input.runPrompt(
          {
            backend: selection.backend,
            endpoint: selection.endpoint,
            model: selection.model.id,
            timeoutMs: settings.timeoutMs,
            allowRemote: settings.allowRemote,
            ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
          },
          CONTRACT_PROBE_PROMPT,
          signal,
        );
        const text = typeof answer === "string" ? answer : answer.text;
        const wrongModel = typeof answer === "string"
          ? undefined
          : contractIdentityRefusal({ requested: selection.model.id, answered: answer.model });
        // The configuration may have changed while the server was thinking. An answer about a tuple
        // nobody is configured for any more is not published as a verdict, and readiness is left to
        // the check the new configuration starts.
        if (generation !== ownGeneration) {
          return;
        }
        // A server that answered as a different model has told us the tuple under test is not the
        // tuple that ran. The verdict belongs to that tuple's name, so it is recorded as a refusal.
        // The interpreter's own parser, reading the answer exactly as it will read a real one. A
        // reader assembled here — or handed in by the caller — could be laxer than the production
        // one, and then the gate would pass models the interpreter goes on to refuse.
        const verdict = wrongModel === undefined
          ? contractProbeVerdict(parseLocalDecision(text))
          : { compatible: false, detail: wrongModel };
        verdicts.set(key, verdict.compatible);
        input.log?.(
          `Local interpreter check: ${selection.model.id} on ${selection.endpoint} ${verdict.compatible ? "passed" : "failed"} — ${verdict.detail}`,
        );
      } catch (error) {
        // A request that failed says nothing certain about the model — it may have failed to load,
        // or the server may be gone — so no verdict is recorded and it is not condemned. The search
        // continues: treating every exception as "the backend is unreachable" gave up on models and
        // backends that would have worked. The attempted set bounds the loop.
        if (generation !== ownGeneration) {
          return;
        }
        input.log?.(
          `Local interpreter check could not run for ${selection.model.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  return {
    discover: async () => {
      await input.registry.discover(localBackendIdentities(input.settings()));
    },
    readiness,
    resolvedConfig: (consumer) => {
      if (!consumerSettings(consumer).enabled) {
        return undefined;
      }
      const selection = selectionFor(consumer);
      return selection.status === "ready"
        ? { backend: selection.backend, endpoint: selection.endpoint, model: selection.model.id }
        : undefined;
    },
    verifySelection: async (signal) => {
      // Stated here as well as in the identities above, because this is the call that spends a
      // reader's memory and CPU. A host with no consumer enabled performs no inference, and a guard
      // that only held while discovery happened to be empty would be one refactor away from not
      // holding.
      if (!LOCAL_CONSUMERS.some((consumer) => consumerSettings(consumer).enabled)) {
        return;
      }
      if (verifying) {
        return verifying;
      }
      const ownGeneration = generation;
      const controller = new AbortController();
      verifyAbort = controller;
      const abortFromCaller = () => controller.abort();
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      if (signal?.aborted) controller.abort();
      verifying = (async () => {
        try {
          const attempted = new Set<ContractCheckKey>();
          for (const consumer of LOCAL_CONSUMERS) {
            await verifyConsumer(consumer, ownGeneration, controller.signal, attempted);
          }
        } finally {
          signal?.removeEventListener("abort", abortFromCaller);
          if (verifyAbort === controller) verifyAbort = undefined;
          // Only the pass that is still current clears the slot. A pass superseded by `invalidate`
          // already handed the slot to nobody, and must not erase the one that replaced it.
          if (generation === ownGeneration) verifying = undefined;
        }
      })();
      return verifying;
    },
    invalidate: () => {
      // A check in flight is answering the previous configuration. It is cancelled, its generation
      // is retired so a late answer cannot repopulate anything, and the promise is dropped so the
      // next verification starts on the new configuration instead of awaiting the old one.
      generation += 1;
      verdicts.clear();
      verifyAbort?.abort();
      verifyAbort = undefined;
      verifying = undefined;
      // Every local-backend record, not only the ones the current settings would ask about: the
      // settings change that brings us here is often the one that removed an endpoint or turned the
      // feature off, and a record scoped to the new settings can never match — and so never drop —
      // the stale answer left by the old ones.
      input.registry.invalidate((record) =>
        localBackendForAdapterType(record.adapterType) !== undefined);
    },
  };
};

/**
 * What the settings view shows, and what a workflow that needs the interpreter is told before it
 * runs. Each status names the remedy, because "unavailable" alone sends a reader to the wrong fix.
 */
export const localModelStatusText = (readinessValue: LocalModelReadiness): string => {
  if (!readinessValue.enabled) {
    return "Local interpretation is off. Deterministic extraction runs on its own.";
  }
  if (readinessValue.discovering) {
    return "Looking for a local inference server…";
  }
  const selection = readinessValue.selection;
  if (selection.status === "ready") {
    return `${selection.model.id} on ${selection.endpoint}${selection.explicit ? " (your choice)" : ""}`;
  }
  if (selection.status === "unverified") {
    return `${selection.model.id} on ${selection.endpoint} — not yet checked against the interpreter contract`;
  }
  if (selection.status === "serverUnavailable") {
    return `No local inference server answered. Start Ollama or LM Studio, or set an endpoint. ${selection.detail}`;
  }
  if (selection.status === "configuredModelUnavailable") {
    return `The model you selected is not available: ${selection.detail}`;
  }
  return `No suitable model is available. ${selection.detail}`;
};
