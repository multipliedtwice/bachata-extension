import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { isSqliteContentionError, openSqliteDatabase, withImmediateTransaction } from "../state/sqlite";

export type ResourceKind = "abstract" | "physical";

export type ResourceClaim = {
  key: string;
  units?: number;
  capacity?: number;
  kind?: ResourceKind;
};

export type ResourceAcquireRequest = {
  resources: ResourceClaim[];
  deadlineAt: number;
  signal?: AbortSignal;
  label?: string;
};

export type ResourceQuarantine = {
  key: string;
  reason: string;
  quarantinedAt: number;
  ownerId?: string;
};

export type ResourceLease = {
  id: string;
  resources: ResourceClaim[];
  fences: Readonly<Record<string, number>>;
  signal: AbortSignal;
  isValid: () => boolean;
  assertValid: () => void;
  release: () => Promise<void>;
  quarantine: (reason: string) => Promise<void>;
};

export type ResourceBrokerOptions = {
  databasePath: string;
  ownerId?: string;
  now?: () => number;
  monotonicNow?: () => number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  staleOwnerMs?: number;
};

export type ResourceBroker = {
  ownerId: string;
  acquire: (request: ResourceAcquireRequest) => Promise<ResourceLease>;
  describeLeaseHolder: (resourceKey: string) => { held: boolean; heartbeatAt?: number };
  listQuarantine: () => ResourceQuarantine[];
  clearQuarantine: (keys?: string[]) => number;
  dispose: () => Promise<void>;
};

export class ResourceAcquireTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceAcquireTimeoutError";
  }
}

export class ResourceAcquireCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceAcquireCancelledError";
  }
}

export class ResourceCapacityExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceCapacityExceededError";
  }
}

export class ResourceLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLeaseLostError";
  }
}

export class ResourceQuarantinedError extends Error {
  readonly keys: string[];

  constructor(keys: string[]) {
    super(`Shared resource is quarantined: ${keys.join(", ")}`);
    this.name = "ResourceQuarantinedError";
    this.keys = keys;
  }
}

type NormalizedClaim = Required<Pick<ResourceClaim, "key" | "units" | "capacity" | "kind">>;

type PendingRow = {
  sequence: number;
  request_id: string;
  resources_json: string;
};

type LeaseItemRow = {
  resource_key: string;
  units: number;
  capacity: number;
  kind: ResourceKind;
  fence_token: number;
};

type LocalLeaseState = {
  claims: NormalizedClaim[];
  fences: Readonly<Record<string, number>>;
  controller: AbortController;
  invalidReason?: string;
};

const positiveInteger = (value: number | undefined, fallback: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return fallback;
  }
  return value as number;
};

const normalizeClaims = (claims: ResourceClaim[]): NormalizedClaim[] => {
  const merged = new Map<string, NormalizedClaim>();
  for (const claim of claims) {
    const key = claim.key.trim();
    if (!key || key.length > 512 || key.includes("\0")) {
      throw new Error("Invalid resource key");
    }
    const units = positiveInteger(claim.units, 1);
    const capacity = positiveInteger(claim.capacity, 1);
    const kind = claim.kind === "physical" ? "physical" : "abstract";
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { key, units, capacity, kind });
      continue;
    }
    existing.units += units;
    existing.capacity = Math.min(existing.capacity, capacity);
    if (kind === "physical") {
      existing.kind = "physical";
    }
  }
  const normalized = Array.from(merged.values()).sort((left, right) =>
    left.key.localeCompare(right.key)
  );
  const invalid = normalized.find((claim) => claim.units > claim.capacity);
  if (invalid) {
    throw new ResourceCapacityExceededError(
      `Requested ${String(invalid.units)} unit(s) of ${invalid.key}, but its capacity is ${String(invalid.capacity)}`,
    );
  }
  return normalized;
};

const parseClaims = (value: string): NormalizedClaim[] => {
  const parsed = JSON.parse(value) as ResourceClaim[];
  return normalizeClaims(parsed);
};

const overlaps = (left: NormalizedClaim[], right: NormalizedClaim[]): boolean => {
  const keys = new Set(left.map((claim) => claim.key));
  return right.some((claim) => keys.has(claim.key));
};

const beginImmediate = withImmediateTransaction;

const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ResourceAcquireCancelledError("Shared-resource wait was cancelled"));
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ResourceAcquireCancelledError("Shared-resource wait was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

const retry = async (operation: () => void): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      operation();
      return;
    } catch (error) {
      if (!isSqliteContentionError(error)) {
        throw error;
      }
      lastError = error;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20 * (attempt + 1));
        timer.unref?.();
      });
    }
  }
  throw lastError;
};

export const resourceKey = (namespace: string, identity: string): string => {
  const hash = createHash("sha256").update(identity).digest("hex");
  return `${namespace}:${hash}`;
};

export const createResourceBroker = (options: ResourceBrokerOptions): ResourceBroker => {
  mkdirSync(path.dirname(options.databasePath), { recursive: true });
  const database = openSqliteDatabase(options.databasePath, (value) => {
    value.exec("PRAGMA journal_mode = WAL");
    value.exec("PRAGMA foreign_keys = ON");
    // Schema creation, the column check and the ALTER that acts on it are one step: two hosts
    // opening this database at once would otherwise both read a missing column, and the loser's
    // duplicate ALTER is SQLITE_ERROR, which no retry heals and which leaves the migration
    // half-applied.
    withImmediateTransaction(value, () => {
      value.exec(`
        CREATE TABLE IF NOT EXISTS resource_owner (
          owner_id TEXT PRIMARY KEY,
          heartbeat_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_request (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL,
          requested_at INTEGER NOT NULL,
          deadline_at INTEGER NOT NULL,
          label TEXT,
          resources_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_lease (
          lease_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          acquired_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_lease_item (
          lease_id TEXT NOT NULL REFERENCES resource_lease(lease_id) ON DELETE CASCADE,
          resource_key TEXT NOT NULL,
          units INTEGER NOT NULL,
          capacity INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('abstract', 'physical')),
          fence_token INTEGER NOT NULL,
          PRIMARY KEY (lease_id, resource_key)
        );
        CREATE TABLE IF NOT EXISTS resource_capacity (
          resource_key TEXT PRIMARY KEY,
          capacity INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_fence (
          resource_key TEXT PRIMARY KEY,
          token INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_quarantine (
          resource_key TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL,
          owner_id TEXT
        );
        CREATE INDEX IF NOT EXISTS resource_request_owner_idx ON resource_request(owner_id);
        CREATE INDEX IF NOT EXISTS resource_lease_owner_idx ON resource_lease(owner_id);
        CREATE INDEX IF NOT EXISTS resource_lease_item_key_idx ON resource_lease_item(resource_key);
      `);
      const leaseColumns = new Set(
        (value.prepare("PRAGMA table_info(resource_lease_item)").all() as Array<Record<string, unknown>>)
          .map((row) => String(row.name)),
      );
      if (!leaseColumns.has("capacity")) {
        value.exec("ALTER TABLE resource_lease_item ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1");
      }
      if (!leaseColumns.has("fence_token")) {
        value.exec("ALTER TABLE resource_lease_item ADD COLUMN fence_token INTEGER NOT NULL DEFAULT 0");
      }
      value.exec("DELETE FROM resource_capacity");
    });
  });

  const ownerId = options.ownerId ?? randomUUID();
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 100);
  const heartbeatIntervalMs = Math.max(50, options.heartbeatIntervalMs ?? 2_000);
  const staleOwnerMs = Math.max(heartbeatIntervalMs * 2, options.staleOwnerMs ?? 15_000);
  const localLeases = new Map<string, LocalLeaseState>();
  let disposed = false;
  const pendingAcquisitions = new Set<Promise<void>>();
  let lastMaintenanceAt = monotonicNow();
  let lastWallTime = now();
  let staleCleanupBlockedUntil = lastMaintenanceAt + staleOwnerMs;

  const heartbeatStatement = database.prepare(`
    INSERT INTO resource_owner(owner_id, heartbeat_at)
    VALUES (?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at
  `);
  const removeOwnerStatement = database.prepare("DELETE FROM resource_owner WHERE owner_id = ?");
  const removeOwnerRequestsStatement = database.prepare("DELETE FROM resource_request WHERE owner_id = ?");

  const quarantinedKeys = (claims: NormalizedClaim[]): string[] =>
    (database.prepare(
      `SELECT resource_key FROM resource_quarantine WHERE resource_key IN (${claims.map(() => "?").join(",")})`,
    ).all(...claims.map((claim) => claim.key)) as Array<{ resource_key: string }>)
      .map((row) => row.resource_key);

  const invalidateLease = (leaseId: string, reason: string): void => {
    const state = localLeases.get(leaseId);
    if (!state || state.invalidReason) {
      return;
    }
    state.invalidReason = reason;
    state.controller.abort(new ResourceLeaseLostError(reason));
  };

  const invalidateAllLeases = (reason: string): void => {
    localLeases.forEach((_state, leaseId) => invalidateLease(leaseId, reason));
  };

  const leaseIsPersisted = (leaseId: string, state: LocalLeaseState): boolean => {
    if (state.invalidReason || disposed) {
      return false;
    }
    const rows = database.prepare(`
      SELECT item.resource_key, item.fence_token
      FROM resource_lease AS lease
      JOIN resource_lease_item AS item ON item.lease_id = lease.lease_id
      WHERE lease.lease_id = ? AND lease.owner_id = ?
    `).all(leaseId, ownerId) as Array<{ resource_key: string; fence_token: number }>;
    if (rows.length !== state.claims.length) {
      return false;
    }
    const persisted = new Map(rows.map((row) => [row.resource_key, row.fence_token]));
    return state.claims.every((claim) => persisted.get(claim.key) === state.fences[claim.key]);
  };

  const assertLeaseValid = (leaseId: string): void => {
    const state = localLeases.get(leaseId);
    if (!state) {
      throw new ResourceLeaseLostError("Shared-resource lease is no longer active");
    }
    if (state.invalidReason) {
      throw new ResourceLeaseLostError(state.invalidReason);
    }
    let valid = false;
    try {
      valid = leaseIsPersisted(leaseId, state);
    } catch (error) {
      const reason = `Shared-resource lease could not be verified: ${error instanceof Error ? error.message : String(error)}`;
      invalidateLease(leaseId, reason);
      throw new ResourceLeaseLostError(reason);
    }
    if (!valid) {
      const reason = "Shared-resource lease ownership was replaced or expired";
      invalidateLease(leaseId, reason);
      throw new ResourceLeaseLostError(reason);
    }
  };

  const validateLocalLeases = (): void => {
    for (const [leaseId, state] of localLeases) {
      if (!leaseIsPersisted(leaseId, state)) {
        invalidateLease(leaseId, "Shared-resource lease ownership was replaced or expired");
      }
    }
  };

  const cleanupStaleOwners = (includeHeartbeatStale: boolean): void => {
    const threshold = now() - staleOwnerMs;
    const staleOwners = database.prepare(`
      SELECT owner_id FROM resource_owner
      WHERE ? = 1 AND owner_id <> ? AND heartbeat_at < ?
      UNION
      SELECT owner_id FROM resource_lease
      WHERE owner_id <> ? AND owner_id NOT IN (SELECT owner_id FROM resource_owner)
      UNION
      SELECT owner_id FROM resource_request
      WHERE owner_id <> ? AND owner_id NOT IN (SELECT owner_id FROM resource_owner)
    `).all(includeHeartbeatStale ? 1 : 0, ownerId, threshold, ownerId, ownerId) as Array<{ owner_id: string }>;
    for (const stale of staleOwners) {
      const leases = database
        .prepare("SELECT lease_id FROM resource_lease WHERE owner_id = ?")
        .all(stale.owner_id) as Array<{ lease_id: string }>;
      for (const lease of leases) {
        const items = database
          .prepare("SELECT resource_key, units, capacity, kind, fence_token FROM resource_lease_item WHERE lease_id = ?")
          .all(lease.lease_id) as LeaseItemRow[];
        for (const item of items) {
          if (item.kind === "physical") {
            database.prepare(`
              INSERT INTO resource_quarantine(resource_key, reason, quarantined_at, owner_id)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(resource_key) DO UPDATE SET
                reason = excluded.reason,
                quarantined_at = excluded.quarantined_at,
                owner_id = excluded.owner_id
            `).run(item.resource_key, "Resource owner heartbeat expired", now(), stale.owner_id);
          }
        }
        database.prepare("DELETE FROM resource_lease WHERE lease_id = ?").run(lease.lease_id);
      }
      removeOwnerRequestsStatement.run(stale.owner_id);
      removeOwnerStatement.run(stale.owner_id);
    }
  };

  const maintainOwners = (): void => {
    const maintenanceAt = monotonicNow();
    const wallTime = now();
    const localGap = maintenanceAt - lastMaintenanceAt;
    const wallGap = wallTime - lastWallTime;
    const clockDrift = Math.abs(wallGap - localGap);
    if (
      localGap > staleOwnerMs ||
      clockDrift > Math.max(1_000, heartbeatIntervalMs * 2)
    ) {
      staleCleanupBlockedUntil = Math.max(
        staleCleanupBlockedUntil,
        maintenanceAt + staleOwnerMs,
      );
    }
    beginImmediate(database, () => {
      heartbeatStatement.run(ownerId, wallTime);
      cleanupStaleOwners(maintenanceAt >= staleCleanupBlockedUntil);
    });
    validateLocalLeases();
    lastMaintenanceAt = maintenanceAt;
    lastWallTime = wallTime;
  };

  const heartbeat = (): void => {
    if (disposed) {
      return;
    }
    maintainOwners();
  };

  heartbeat();
  const heartbeatTimer = setInterval(() => {
    try {
      heartbeat();
    } catch (error) {
      invalidateAllLeases(
        `Shared-resource heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  const settleLease = async (
    leaseId: string,
    claims: NormalizedClaim[],
    quarantineReason?: string,
  ): Promise<void> => {
    const state = localLeases.get(leaseId);
    if (!state) {
      return;
    }
    await retry(() => {
      beginImmediate(database, () => {
        if (quarantineReason) {
          for (const claim of claims) {
            if (claim.kind !== "physical") {
              continue;
            }
            database.prepare(`
              INSERT INTO resource_quarantine(resource_key, reason, quarantined_at, owner_id)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(resource_key) DO UPDATE SET
                reason = excluded.reason,
                quarantined_at = excluded.quarantined_at,
                owner_id = excluded.owner_id
            `).run(claim.key, quarantineReason, now(), ownerId);
          }
        }
        database.prepare("DELETE FROM resource_lease WHERE lease_id = ? AND owner_id = ?")
          .run(leaseId, ownerId);
      });
    });
    localLeases.delete(leaseId);
  };

  const effectiveCapacity = (
    resourceKeyValue: string,
    fallback: number,
    requestSequence: number,
  ): number => {
    let capacity = fallback;
    const leaseRows = database.prepare(
      "SELECT capacity FROM resource_lease_item WHERE resource_key = ?",
    ).all(resourceKeyValue) as Array<{ capacity: number }>;
    leaseRows.forEach((row) => {
      capacity = Math.min(capacity, row.capacity);
    });
    const pendingRows = database.prepare(
      "SELECT resources_json FROM resource_request WHERE sequence <= ?",
    ).all(requestSequence) as Array<{ resources_json: string }>;
    pendingRows.forEach((row) => {
      const claim = parseClaims(row.resources_json).find((value) => value.key === resourceKeyValue);
      if (claim) {
        capacity = Math.min(capacity, claim.capacity);
      }
    });
    return capacity;
  };

  const assertNotDisposed = (): void => {
    if (disposed) {
      throw new ResourceAcquireCancelledError("Resource broker is disposed");
    }
  };

  const acquireInternal = async (request: ResourceAcquireRequest): Promise<ResourceLease> => {
    assertNotDisposed();
    const resources = normalizeClaims(request.resources);
    if (resources.length === 0) {
      const controller = new AbortController();
      return {
        id: `empty-${randomUUID()}`,
        resources: [],
        fences: {},
        signal: controller.signal,
        isValid: () => true,
        assertValid: () => undefined,
        release: async () => undefined,
        quarantine: async () => undefined,
      };
    }
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= now()) {
      throw new ResourceAcquireTimeoutError("Shared-resource acquisition deadline expired");
    }
    if (request.signal?.aborted) {
      throw new ResourceAcquireCancelledError("Shared-resource wait was cancelled");
    }
    const initialQuarantine = quarantinedKeys(resources);
    if (initialQuarantine.length > 0) {
      throw new ResourceQuarantinedError(initialQuarantine);
    }

    const monotonicDeadlineAt = monotonicNow() + Math.max(1, request.deadlineAt - now());
    const requestId = randomUUID();
    maintainOwners();
    beginImmediate(database, () => {
      database.prepare(`
        INSERT INTO resource_request(request_id, owner_id, requested_at, deadline_at, label, resources_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        ownerId,
        now(),
        request.deadlineAt,
        request.label ?? null,
        JSON.stringify(resources),
      );
    });

    const removePending = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      await retry(() => {
        beginImmediate(database, () => {
          database.prepare("DELETE FROM resource_request WHERE request_id = ? AND owner_id = ?")
            .run(requestId, ownerId);
        });
      });
    };

    try {
      while (true) {
        assertNotDisposed();
        if (request.signal?.aborted) {
          throw new ResourceAcquireCancelledError("Shared-resource wait was cancelled");
        }
        if (now() >= request.deadlineAt || monotonicNow() >= monotonicDeadlineAt) {
          throw new ResourceAcquireTimeoutError(
            `Timed out waiting for shared resources${request.label ? ` for ${request.label}` : ""}`,
          );
        }

        maintainOwners();
        const outcome = beginImmediate(database, () => {
          const current = database
            .prepare("SELECT sequence FROM resource_request WHERE request_id = ? AND owner_id = ?")
            .get(requestId, ownerId) as { sequence: number } | undefined;
          if (!current) {
            throw new ResourceAcquireCancelledError("Shared-resource request no longer exists");
          }

          const quarantined = quarantinedKeys(resources);
          if (quarantined.length > 0) {
            return { type: "quarantined" as const, keys: quarantined };
          }

          const earlier = database
            .prepare("SELECT sequence, request_id, resources_json FROM resource_request WHERE sequence < ? ORDER BY sequence ASC")
            .all(current.sequence) as PendingRow[];
          if (earlier.some((row) => overlaps(resources, parseClaims(row.resources_json)))) {
            return { type: "waiting" as const };
          }

          for (const claim of resources) {
            const usageRow = database
              .prepare("SELECT COALESCE(SUM(units), 0) AS used FROM resource_lease_item WHERE resource_key = ?")
              .get(claim.key) as { used: number };
            if (usageRow.used + claim.units > effectiveCapacity(claim.key, claim.capacity, current.sequence)) {
              return { type: "waiting" as const };
            }
          }

          const leaseId = randomUUID();
          const fences: Record<string, number> = {};
          database.prepare("INSERT INTO resource_lease(lease_id, owner_id, acquired_at) VALUES (?, ?, ?)")
            .run(leaseId, ownerId, now());
          for (const claim of resources) {
            database.prepare(`
              INSERT INTO resource_fence(resource_key, token)
              VALUES (?, 1)
              ON CONFLICT(resource_key) DO UPDATE SET token = resource_fence.token + 1
            `).run(claim.key);
            const fence = database.prepare(
              "SELECT token FROM resource_fence WHERE resource_key = ?",
            ).get(claim.key) as { token: number };
            fences[claim.key] = fence.token;
            database.prepare(`
              INSERT INTO resource_lease_item(lease_id, resource_key, units, capacity, kind, fence_token)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(leaseId, claim.key, claim.units, claim.capacity, claim.kind, fence.token);
          }
          database.prepare("DELETE FROM resource_request WHERE request_id = ?").run(requestId);
          return { type: "acquired" as const, leaseId, fences };
        });

        if (outcome.type === "quarantined") {
          throw new ResourceQuarantinedError(outcome.keys);
        }
        if (outcome.type === "acquired") {
          const controller = new AbortController();
          const state: LocalLeaseState = {
            claims: resources,
            fences: Object.freeze({ ...outcome.fences }),
            controller,
          };
          localLeases.set(outcome.leaseId, state);
          if (disposed) {
            await settleLease(
              outcome.leaseId,
              resources,
              "Resource broker was disposed while this lease was being granted",
            );
            throw new ResourceAcquireCancelledError("Resource broker is disposed");
          }
          let settlement: Promise<void> | undefined;
          const settle = async (reason?: string): Promise<void> => {
            if (settlement) {
              return settlement;
            }
            settlement = settleLease(outcome.leaseId, resources, reason).catch((error) => {
              settlement = undefined;
              throw error;
            });
            return settlement;
          };
          return {
            id: outcome.leaseId,
            resources,
            fences: state.fences,
            signal: controller.signal,
            isValid: () => {
              try {
                assertLeaseValid(outcome.leaseId);
                return true;
              } catch {
                return false;
              }
            },
            assertValid: () => assertLeaseValid(outcome.leaseId),
            release: () => settle(),
            quarantine: (reason) => settle(reason || "Cleanup was not confirmed"),
          };
        }
        const remaining = Math.min(
          request.deadlineAt - now(),
          monotonicDeadlineAt - monotonicNow(),
        );
        await delay(Math.min(pollIntervalMs, Math.max(1, remaining)), request.signal);
      }
    } catch (error) {
      try {
        await removePending();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Shared-resource acquisition and pending-request cleanup both failed",
        );
      }
      throw error;
    }
  };

  const acquire = async (request: ResourceAcquireRequest): Promise<ResourceLease> => {
    if (disposed) {
      throw new Error("Resource broker is disposed");
    }
    const running = acquireInternal(request);
    const settled: Promise<void> = running.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      pendingAcquisitions.delete(settled);
    });
    pendingAcquisitions.add(settled);
    return running;
  };

  const listQuarantine = (): ResourceQuarantine[] =>
    (database.prepare(`
      SELECT resource_key AS key, reason, quarantined_at AS quarantinedAt, owner_id AS ownerId
      FROM resource_quarantine
      ORDER BY quarantined_at ASC, resource_key ASC
    `).all() as ResourceQuarantine[]);

  const describeLeaseHolder = (resourceKey: string): { held: boolean; heartbeatAt?: number } =>
    beginImmediate(database, () => {
      const row = database.prepare(`
        SELECT owner.heartbeat_at AS heartbeatAt
        FROM resource_lease_item AS item
        JOIN resource_lease AS lease ON lease.lease_id = item.lease_id
        JOIN resource_owner AS owner ON owner.owner_id = lease.owner_id
        WHERE item.resource_key = ?
        ORDER BY lease.acquired_at DESC
        LIMIT 1
      `).get(resourceKey) as { heartbeatAt: number } | undefined;
      return row ? { held: true, heartbeatAt: row.heartbeatAt } : { held: false };
    });

  const clearQuarantine = (keys?: string[]): number => beginImmediate(database, () => {
    if (!keys || keys.length === 0) {
      return Number(database.prepare("DELETE FROM resource_quarantine").run().changes);
    }
    const normalized = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
    if (normalized.length === 0) {
      return 0;
    }
    return Number(database.prepare(`DELETE FROM resource_quarantine WHERE resource_key IN (${normalized.map(() => "?").join(",")})`)
      .run(...normalized).changes);
  });

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearInterval(heartbeatTimer);
    await Promise.allSettled(Array.from(pendingAcquisitions));
    const failures: unknown[] = [];
    const active = Array.from(localLeases.entries());
    for (const [leaseId, state] of active) {
      try {
        await settleLease(leaseId, state.claims, "Resource broker disposed before cleanup was confirmed");
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      beginImmediate(database, () => {
        removeOwnerRequestsStatement.run(ownerId);
        if (failures.length === 0) {
          removeOwnerStatement.run(ownerId);
        }
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      database.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Resource broker cleanup was not fully confirmed: ${failures
          .map((failure) => failure instanceof Error ? failure.message : String(failure))
          .join("; ")}`,
      );
    }
  };

  return {
    ownerId,
    acquire,
    describeLeaseHolder,
    listQuarantine,
    clearQuarantine,
    dispose,
  };
};
