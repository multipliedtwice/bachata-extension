import { shouldOpenProviderResourceCircuit, type ProviderFailure } from "../adapters/providerFailure";

export type ProviderResourceLease = {
  release(): void;
};

export type ProviderResourceState = {
  resourceId: string;
  maxConcurrency: number;
  maxQueue: number;
  active: number;
  queued: number;
  circuit: "closed" | "open";
  failure?: ProviderFailure | undefined;
};

type Waiter = {
  resolve: (lease: ProviderResourceLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

type Resource = ProviderResourceState & {
  waiters: Waiter[];
};

const abortError = (): Error => {
  const error = new Error("Provider resource acquisition interrupted");
  error.name = "AbortError";
  return error;
};

export class ProviderResourceBroker {
  private readonly resources = new Map<string, Resource>();

  configure(resourceId: string, maxConcurrency = 1, maxQueue = 32): void {
    const current = this.resources.get(resourceId);
    if (current) {
      current.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
      current.maxQueue = Math.max(0, Math.floor(maxQueue));
      this.drain(current);
      return;
    }
    this.resources.set(resourceId, {
      resourceId,
      maxConcurrency: Math.max(1, Math.floor(maxConcurrency)),
      maxQueue: Math.max(0, Math.floor(maxQueue)),
      active: 0,
      queued: 0,
      circuit: "closed",
      waiters: [],
    });
  }

  async acquire(resourceId: string, signal?: AbortSignal): Promise<ProviderResourceLease> {
    const resource = this.getOrCreate(resourceId);
    this.resetExpiredCircuit(resource);
    if (resource.circuit === "open") {
      throw new Error(resource.failure?.message ?? `Provider resource ${resourceId} is unavailable`);
    }
    if (signal?.aborted) {
      throw abortError();
    }
    if (resource.active < resource.maxConcurrency) {
      resource.active += 1;
      return this.createLease(resource);
    }
    if (resource.waiters.length >= resource.maxQueue) {
      throw new Error(`Provider resource queue is full: ${resourceId}`);
    }
    return await new Promise<ProviderResourceLease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abort = () => {
          const index = resource.waiters.indexOf(waiter);
          if (index >= 0) {
            resource.waiters.splice(index, 1);
            resource.queued = resource.waiters.length;
          }
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      resource.waiters.push(waiter);
      resource.queued = resource.waiters.length;
    });
  }

  reportFailure(failure: ProviderFailure): void {
    const resource = this.getOrCreate(failure.resourceId);
    resource.failure = failure;
    if (shouldOpenProviderResourceCircuit(failure)) {
      const resetDelayMs = failure.code === "authenticationRequired" ? 60_000 : 300_000;
      const now = Date.now();
      const fallbackResetAt = now + resetDelayMs;
      const suppliedResetAt = failure.resetAt ? Date.parse(failure.resetAt) : Number.NaN;
      const resetAtMs = Number.isFinite(suppliedResetAt)
        ? Math.min(suppliedResetAt, fallbackResetAt)
        : fallbackResetAt;
      resource.failure = { ...failure, resetAt: new Date(resetAtMs).toISOString() };
      resource.circuit = "open";
      for (const waiter of resource.waiters.splice(0)) {
        if (waiter.signal && waiter.abort) {
          waiter.signal.removeEventListener("abort", waiter.abort);
        }
        waiter.reject(new Error(failure.message));
      }
      resource.queued = 0;
    }
  }

  reset(resourceId: string): void {
    const resource = this.getOrCreate(resourceId);
    resource.circuit = "closed";
    delete resource.failure;
    this.drain(resource);
  }

  snapshot(resourceId: string): ProviderResourceState {
    const resource = this.getOrCreate(resourceId);
    this.resetExpiredCircuit(resource);
    return {
      resourceId: resource.resourceId,
      maxConcurrency: resource.maxConcurrency,
      maxQueue: resource.maxQueue,
      active: resource.active,
      queued: resource.waiters.length,
      circuit: resource.circuit,
      failure: resource.failure,
    };
  }

  private resetExpiredCircuit(resource: Resource): void {
    if (resource.circuit !== "open" || !resource.failure?.resetAt) return;
    const resetAt = Date.parse(resource.failure.resetAt);
    if (!Number.isFinite(resetAt) || resetAt > Date.now()) return;
    resource.circuit = "closed";
    delete resource.failure;
    this.drain(resource);
  }

  private getOrCreate(resourceId: string): Resource {
    const existing = this.resources.get(resourceId);
    if (existing) {
      return existing;
    }
    this.configure(resourceId, 1);
    return this.resources.get(resourceId)!;
  }

  private createLease(resource: Resource): ProviderResourceLease {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        resource.active = Math.max(0, resource.active - 1);
        this.drain(resource);
      },
    };
  }

  private drain(resource: Resource): void {
    if (resource.circuit === "open") {
      return;
    }
    while (resource.active < resource.maxConcurrency && resource.waiters.length > 0) {
      const waiter = resource.waiters.shift()!;
      resource.queued = resource.waiters.length;
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener("abort", waiter.abort);
      }
      resource.active += 1;
      waiter.resolve(this.createLease(resource));
    }
  }
}

export const providerResourceBroker = new ProviderResourceBroker();
providerResourceBroker.configure("chatgpt-browser:default-account", 1);
providerResourceBroker.configure("claude-browser:default-account", 1);
providerResourceBroker.configure("generic-browser:default-origin", 1);
providerResourceBroker.configure("local-semantic:default", 1);
