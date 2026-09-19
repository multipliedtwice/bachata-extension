import { browserConversationClaimKey } from "./conversationOwnership";
import { randomBytes } from "node:crypto";

import type { ResourceBroker, ResourceLease } from "../concurrency/resourceBroker";
import type {
  BrowserBridgeSecretStore,
  BrowserBridgeServer,
  BrowserBridgeStatus,
  OwnedBrowserBridgeServer,
} from "./bridgeServer";
import type { BrowserConversationBinding } from "./protocol";
import {
  createSharedBrowserBridgeClient,
  probeBrowserBridgeEndpoint,
  reserveBrowserBridgeEndpoint,
} from "./sharedBridgeTransport";

type Reservation = {
  endpoint: string;
  isHeld: () => boolean;
  release: () => Promise<void>;
};
type BlockedReason = NonNullable<BrowserBridgeStatus["blockedReason"]>;
type RecoveryBroker = Pick<ResourceBroker, "acquire"> & Partial<Pick<ResourceBroker,
  "inspectBrowserBridgeOwnership" | "acquireBrowserBridge">>;
type Timer = ReturnType<typeof setTimeout>;

export type BrowserBridgeRecoveryOptions = {
  enabled: boolean;
  endpoint: string;
  broker: RecoveryBroker;
  secretStore: BrowserBridgeSecretStore;
  createOwnedServer: (
    onStatusChange: (status: BrowserBridgeStatus) => void,
    getSharedToken: () => string | undefined,
  ) => OwnedBrowserBridgeServer;
  onStatusChange: (status: BrowserBridgeStatus) => void;
  log: (message: string) => void;
  probeEndpoint?: typeof probeBrowserBridgeEndpoint;
  reserveEndpoint?: (endpoint: string, signal?: AbortSignal) => Promise<Reservation>;
  createSharedClient?: typeof createSharedBrowserBridgeClient;
  legacyEndpoint?: string;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancelSchedule?: (timer: Timer) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
  healthCheckMs?: number;
  attemptTimeoutMs?: number;
  cleanupTimeoutMs?: number;
};

export type BrowserBridgeRecovery = BrowserBridgeServer & {
  startAutomatic: () => void;
  ensureAvailable: () => Promise<boolean>;
  notifyWake: () => void;
  dispose: () => Promise<void>;
};

const sharedTokenKey = "bachata.browserBridge.sharedToken.v1";
const defaultLegacyEndpoint = "ws://127.0.0.1:43127/bachata-browser-bridge-v9";
const unavailable = (): Error => new Error("Browser unavailable — retrying.");
const endpointOrigin = (endpoint: string): string => new URL(endpoint).origin;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const externalReason = (error: unknown): BlockedReason | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; blockedReason?: unknown };
  if (value.code === "EACCES" || value.code === "EPERM") return "accessDenied";
  if (value.code === "EADDRINUSE") return "portUnavailable";
  switch (value.blockedReason) {
    case "portUnavailable":
    case "localWindowRequired":
    case "browserUpdateRequired":
    case "pairingExpired":
    case "accessDenied":
      return value.blockedReason;
    default:
      return undefined;
  }
};

export const createBrowserBridgeRecovery = (
  options: BrowserBridgeRecoveryOptions,
): BrowserBridgeRecovery => {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  });
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const probe = options.probeEndpoint ?? probeBrowserBridgeEndpoint;
  const reserveEndpoint = options.reserveEndpoint ?? reserveBrowserBridgeEndpoint;
  const createSharedClient = options.createSharedClient ?? createSharedBrowserBridgeClient;
  const legacyEndpoint = options.legacyEndpoint ?? defaultLegacyEndpoint;
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? 500);
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? 15_000);
  const healthCheckMs = Math.max(1, options.healthCheckMs ?? 5_000);
  const attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs ?? 1_500);
  const cleanupTimeoutMs = Math.max(1, options.cleanupTimeoutMs ?? 2_000);
  const abort = new AbortController();
  const listeners = new Set<(status: BrowserBridgeStatus) => void>();
  const bindingChanges = new Map<string, BrowserConversationBinding | undefined>();
  const bindings = new Map<string, BrowserConversationBinding>();
  let active: BrowserBridgeServer | undefined;
  let owned: OwnedBrowserBridgeServer | undefined;
  let lease: ResourceLease | undefined;
  let sharedToken: string | undefined;
  let reservations: Reservation[] = [];
  let activeEndpoint: string | undefined;
  let cleanupRequired = false;
  let cleanupQuarantined = false;
  let credentialWrite: Promise<void> | undefined;
  let cleanupOperation: Promise<void> | undefined;
  let removeLeaseListener: (() => void) | undefined;
  let generation = 0;
  let disposed = false;
  let started = false;
  let attempts = 0;
  let concreteFailures = 0;
  let lastReason: BlockedReason | undefined;
  let operation: Promise<boolean> | undefined;
  let disposal: Promise<void> | undefined;
  let timer: Timer | undefined;
  let status: BrowserBridgeStatus = {
    enabled: options.enabled,
    connected: false,
    sessions: [],
    connectionState: options.enabled ? "connecting" : "disconnected",
  };

  const publish = (next: BrowserBridgeStatus): void => {
    if (disposed) return;
    status = next;
    options.onStatusChange(status);
    for (const listener of listeners) listener(status);
  };
  const recordFailure = (reason: BlockedReason | undefined): void => {
    attempts += 1;
    concreteFailures = reason && reason === lastReason ? concreteFailures + 1 : reason ? 1 : 0;
    lastReason = reason;
  };
  const receivedStatus = (next: BrowserBridgeStatus, countFailure = false): void => {
    if (disposed || cleanupRequired) return;
    const { error, blockedReason, connectionState: _connectionState, ...safe } = next;
    const reason = externalReason({ blockedReason });
    if (next.connected) {
      attempts = 0;
      concreteFailures = 0;
      lastReason = undefined;
    } else if (countFailure && (reason || error)) {
      recordFailure(reason);
    }
    const blocked = !next.connected && reason !== undefined && reason === lastReason && concreteFailures >= 3;
    publish({
      ...safe,
      enabled: options.enabled,
      connectionState: next.connected ? "connected" : blocked ? "blocked" : attempts > 0 || error ? "retrying" : "connecting",
      ...(blocked ? { blockedReason: reason } : {}),
    });
  };
  const nextStatusListener = (): ((next: BrowserBridgeStatus) => void) => {
    const current = ++generation;
    return (next) => {
      if (current === generation) receivedStatus(next);
    };
  };
  const retryStatus = (error?: unknown): void => {
    if (disposed) return;
    const reason = externalReason(error);
    recordFailure(reason);
    const blocked = reason !== undefined && concreteFailures >= 3;
    const { error: _error, blockedReason: _blockedReason, pairingToken: _token, pairingExpiresAt: _expiry, ...safe } = status;
    publish({
      ...safe,
      connected: false,
      sessions: [],
      connectionState: blocked ? "blocked" : "retrying",
      ...(blocked ? { blockedReason: reason } : {}),
    });
    if (error !== undefined) options.log(`Browser connection attempt failed: ${errorText(error)}`);
  };
  const boundedOperation = async <T>(
    run: () => PromiseLike<T>,
    timeoutMs = cleanupTimeoutMs,
    signal?: AbortSignal,
  ): Promise<T> => {
    let deadline: Timer | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw unavailable();
      return await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => { reject(unavailable()); };
          signal?.addEventListener("abort", onAbort, { once: true });
          deadline = schedule(onAbort, timeoutMs);
        }),
      ]);
    } finally {
      if (deadline !== undefined) cancelSchedule(deadline);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
  const boundedAttempt = async <T>(run: (signal: AbortSignal) => PromiseLike<T>): Promise<T> => {
    const controller = new AbortController();
    const onAbort = (): void => { controller.abort(); };
    abort.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (abort.signal.aborted) controller.abort();
      return await boundedOperation(() => run(controller.signal), attemptTimeoutMs, controller.signal);
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
    }
  };
  const assertOpen = (): void => {
    if (disposed || abort.signal.aborted) throw unavailable();
  };
  const performCleanup = async (): Promise<void> => {
    cleanupRequired = true;
    generation += 1;
    removeLeaseListener?.();
    removeLeaseListener = undefined;
    const failures: unknown[] = [];
    if (credentialWrite) {
      const pending = credentialWrite;
      try {
        await boundedOperation(() => pending);
      } catch (error) {
        if (credentialWrite === pending) {
          if (lease) {
            await lease.quarantine("Browser connection credentials are still being saved");
            cleanupQuarantined = true;
          }
          throw error;
        }
      }
    }
    const target = active ?? owned;
    let targetClosed = true;
    if (target) await boundedOperation(() => target.close()).catch((error: unknown) => {
      targetClosed = false;
      failures.push(error);
    });
    for (const [index, reservation] of reservations.entries()) {
      if (owned && index === 0 && !targetClosed) continue;
      await boundedOperation(() => reservation.release()).catch((error: unknown) => { failures.push(error); });
    }
    if (failures.length > 0) {
      if (lease) {
        await lease.quarantine("Browser connection cleanup is incomplete").then(() => {
          cleanupQuarantined = true;
        }).catch((error: unknown) => { failures.push(error); });
      }
      options.log(`Browser connection cleanup failed: ${failures.map(errorText).join("; ")}`);
      throw unavailable();
    }
    if (lease) {
      try {
        await lease.release();
      } catch (error) {
        await lease.quarantine("Browser connection ownership release failed");
        cleanupQuarantined = true;
        options.log(`Browser connection ownership release failed: ${errorText(error)}`);
      }
      if (cleanupQuarantined) await lease.confirmCleanup?.();
    }
    active = undefined;
    owned = undefined;
    lease = undefined;
    sharedToken = undefined;
    reservations = [];
    activeEndpoint = undefined;
    cleanupQuarantined = false;
    cleanupRequired = false;
  };
  const cleanup = (): Promise<void> => {
    if (cleanupOperation) return cleanupOperation;
    cleanupOperation = performCleanup().finally(() => { cleanupOperation = undefined; });
    return cleanupOperation;
  };
  const replayBindings = (): void => {
    for (const [ownerId, binding] of bindings) active?.bindConversation(ownerId, binding);
  };
  const attempt = async (): Promise<boolean> => {
    if (disposed || !options.enabled) return false;
    try {
      if (cleanupRequired || (lease && !lease.isValid())) await cleanup();
      assertOpen();
      if (active && activeEndpoint) {
        const endpoint = activeEndpoint;
        let health: Awaited<ReturnType<typeof probe>>;
        try {
          health = await boundedAttempt((signal) => probe(endpoint, sharedToken, attemptTimeoutMs, signal));
        } catch (error) {
          assertOpen();
          if (cleanupRequired || (lease && !lease.isValid())) throw error;
          retryStatus(error);
          return false;
        }
        assertOpen();
        if (cleanupRequired || (lease && !lease.isValid())) {
          await cleanup();
        } else if (health.reachable && health.status) {
          receivedStatus(health.status, true);
          active.discover();
          return true;
        } else if (health.reachable) {
          retryStatus(health.blockedReason ? { blockedReason: health.blockedReason } : undefined);
          return false;
        } else {
          await cleanup();
        }
      }
      assertOpen();
      const ownership = options.broker.inspectBrowserBridgeOwnership?.();
      const endpoints = [...new Map([
        ownership?.endpoint,
        ...(!ownership?.endpoint && (ownership?.held || ownership?.quarantined) ? [legacyEndpoint] : []),
        ...(new URL(options.endpoint).port === "0" ? [] : [options.endpoint]),
      ]
        .filter((endpoint): endpoint is string => Boolean(endpoint))
        .map((endpoint) => [endpointOrigin(endpoint), endpoint])).values()];
      const token = await boundedAttempt(() => options.secretStore.get(sharedTokenKey));
      assertOpen();
      for (const endpoint of endpoints) {
        const available = await boundedAttempt((signal) => probe(endpoint, token, attemptTimeoutMs, signal));
        assertOpen();
        if (!available.reachable) continue;
        if (!available.status || !token) {
          retryStatus(available.blockedReason ? { blockedReason: available.blockedReason } : undefined);
          return false;
        }
        sharedToken = token;
        activeEndpoint = endpoint;
        active = createSharedClient({ endpoint, token, onStatusChange: nextStatusListener() });
        const shared = active;
        await boundedAttempt(() => shared.start());
        assertOpen();
        receivedStatus(active.getStatus(), true);
        replayBindings();
        active.discover();
        return true;
      }
      owned = options.createOwnedServer(nextStatusListener(), () => sharedToken);
      const serverToReserve = owned;
      reservations.push(await boundedAttempt(() => serverToReserve.reserve()));
      assertOpen();
      const ownedEndpoint = reservations[0]!.endpoint;
      for (const endpoint of endpoints) {
        if (reservations.some((reservation) => endpointOrigin(reservation.endpoint) === endpointOrigin(endpoint))) continue;
        const reservation = await boundedAttempt((signal) => {
          const pending = reserveEndpoint(endpoint, signal);
          void pending.then((value) => signal.aborted ? value.release() : undefined).catch((error: unknown) => {
            options.log(`Browser connection reservation cleanup failed: ${errorText(error)}`);
          });
          return pending;
        });
        reservations.push(reservation);
        assertOpen();
      }
      const request = {
        deadlineAt: now() + attemptTimeoutMs,
        signal: abort.signal,
        endpoint: ownedEndpoint,
        isEndpointReserved: (endpoint: string): boolean => reservations.some((reservation) =>
          reservation.isHeld() && endpointOrigin(reservation.endpoint) === endpointOrigin(endpoint)),
      };
      lease = await boundedAttempt((signal) => {
        const pending = options.broker.acquireBrowserBridge
          ? options.broker.acquireBrowserBridge({ ...request, signal })
          : options.broker.acquire({
            resources: [{ key: "browser-bridge:profile", kind: "physical" }],
            deadlineAt: request.deadlineAt,
            signal,
            label: "Browser connection",
          });
        void pending.then((value) => signal.aborted ? value.release() : undefined).catch((error: unknown) => {
          options.log(`Browser connection ownership attempt ended: ${errorText(error)}`);
        });
        return pending;
      });
      assertOpen();
      lease.assertValid();
      const currentLease = lease;
      const onLeaseLost = (): void => {
        if (lease !== currentLease || disposed) return;
        cleanupRequired = true;
        try {
          void (credentialWrite ? undefined : owned?.close())?.catch((error: unknown) => {
            options.log(`Browser connection shutdown remains pending: ${errorText(error)}`);
          });
        } catch (error) {
          options.log(`Browser connection shutdown remains pending: ${errorText(error)}`);
        }
        void ensureAvailable();
      };
      currentLease.signal.addEventListener("abort", onLeaseLost, { once: true });
      removeLeaseListener = () => { currentLease.signal.removeEventListener("abort", onLeaseLost); };
      sharedToken = await boundedAttempt(() => options.secretStore.get(sharedTokenKey));
      assertOpen();
      if (!sharedToken) {
        sharedToken = randomBytes(32).toString("base64url");
        const pending = Promise.resolve(options.secretStore.store(sharedTokenKey, sharedToken));
        credentialWrite = pending;
        void pending.finally(() => {
          if (credentialWrite === pending) credentialWrite = undefined;
          if (disposed) {
            void cleanup().catch((error: unknown) => {
              options.log(`Browser connection cleanup remains pending: ${errorText(error)}`);
            });
          }
        }).catch(() => undefined);
        await boundedAttempt(() => pending);
      }
      assertOpen();
      lease.assertValid();
      const server = owned;
      await boundedAttempt(() => server.start());
      assertOpen();
      lease.assertValid();
      for (const reservation of reservations.slice(1)) await boundedOperation(() => reservation.release());
      reservations = reservations.slice(0, 1);
      active = owned;
      activeEndpoint = ownedEndpoint;
      replayBindings();
      receivedStatus(active.getStatus(), true);
      active.discover();
      return true;
    } catch (error) {
      await cleanup().catch((cleanupError: unknown) => {
        options.log(`Browser connection recovery remains pending: ${errorText(cleanupError)}`);
      });
      retryStatus(error);
      return false;
    }
  };
  const queueNext = (available: boolean): void => {
    if (disposed || !started || !options.enabled) return;
    if (timer !== undefined) cancelSchedule(timer);
    const delay = available ? healthCheckMs : Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(20, Math.max(0, attempts - 1)));
    timer = schedule(() => {
      timer = undefined;
      void ensureAvailable();
    }, delay);
  };
  const ensureAvailable = (): Promise<boolean> => {
    if (operation) return operation;
    if (disposed || !options.enabled) return Promise.resolve(false);
    if (timer !== undefined) {
      cancelSchedule(timer);
      timer = undefined;
    }
    operation = attempt().then((available) => {
      queueNext(available);
      return available;
    }).finally(() => { operation = undefined; });
    return operation;
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    abort.abort();
    if (timer !== undefined) cancelSchedule(timer);
    timer = undefined;
    listeners.clear();
    bindings.clear();
    disposal = (async () => {
      await operation;
      await cleanup();
    })();
    return disposal;
  };
  const requireActive = (): BrowserBridgeServer => {
    if (!active || disposed || cleanupRequired || (lease && !lease.isValid())) throw unavailable();
    return active;
  };
  return {
    startAutomatic: () => {
      if (started || disposed) return;
      started = true;
      publish(status);
      void ensureAvailable();
    },
    ensureAvailable,
    notifyWake: () => {
      if (started && !disposed) void ensureAvailable();
    },
    dispose,
    start: async () => { await ensureAvailable(); },
    getStatus: () => status,
    subscribeStatus: (listener) => {
      listeners.add(listener);
      listener({ ...status, sessions: [...status.sessions] });
      return { dispose: () => { listeners.delete(listener); } };
    },
    resetPairing: async () => { await requireActive().resetPairing(); },
    discover: () => { active?.discover(); },
    refreshLocalModelConfig: () => { active?.refreshLocalModelConfig(); },
    openConversation: (...args) => requireActive().openConversation(...args),
    bindSession: (ownerId, sessionId) => {
      const binding = requireActive().bindSession(ownerId, sessionId);
      bindings.set(ownerId, binding);
      return binding;
    },
    bindConversation: (ownerId, binding) => {
      if (bindingChanges.has(ownerId)) {
        const target = bindingChanges.get(ownerId);
        if (!target || browserConversationClaimKey(target) !== browserConversationClaimKey(binding)) throw unavailable();
        return;
      }
      active?.bindConversation(ownerId, binding);
      bindings.set(ownerId, binding);
    },
    releaseBinding: (ownerId) => {
      if (bindingChanges.has(ownerId)) return;
      bindings.delete(ownerId);
      active?.releaseBinding(ownerId);
    },
    beginBindingChange: async (ownerId, target) => {
      if (bindingChanges.has(ownerId)) throw unavailable();
      const previous = bindings.get(ownerId);
      const host = requireActive();
      bindingChanges.set(ownerId, target);
      let change;
      try { change = await host.beginBindingChange(ownerId, target); }
      catch (error) { bindingChanges.delete(ownerId); throw error; }
      if (target) bindings.set(ownerId, target);
      else bindings.delete(ownerId);
      const finish = async (decision: "commit" | "rollback"): Promise<void> => {
        if (decision === "commit" && requireActive() !== host) throw unavailable();
        await change[decision]();
        const value = decision === "commit" ? target : previous;
        if (value) bindings.set(ownerId, value);
        else bindings.delete(ownerId);
        bindingChanges.delete(ownerId);
      };
      return { commit: () => finish("commit"), rollback: () => finish("rollback") };
    },
    resolveBoundSession: (...args) => active?.resolveBoundSession(...args),
    sendConversation: async function* (...args) { yield* requireActive().sendConversation(...args); },
    fetchAsset: async function* (...args) { yield* requireActive().fetchAsset(...args); },
    revealAsset: (...args) => requireActive().revealAsset(...args),
    interrupt: (...args) => requireActive().interrupt(...args),
    close: dispose,
  };
};
