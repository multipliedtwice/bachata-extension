import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import { isSqliteContentionError, openSqliteDatabase } from "./sqlite";

export type WorkspaceMutationRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export type WorkspaceMutationFence = {
  run: WorkspaceMutationRunner;
  dispose: () => Promise<void>;
};

export type WorkspaceWriterFence = {
  resourceKey: string;
  token: number;
};

export type WorkspaceMutationFenceOptions = WorkspaceWriterFence & {
  assertWritable?: () => void;
  acquisitionTimeoutMs?: number;
};

const delay = (milliseconds: number): Promise<void> => setTimeout(milliseconds, undefined);

const rollback = (database: DatabaseSync, original: unknown): never => {
  try {
    database.exec("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [original, rollbackError],
      "Workspace mutation failed and its fence transaction could not be rolled back",
    );
  }
  throw original;
};

const validateFence = (fence: WorkspaceWriterFence): void => {
  if (!fence.resourceKey.trim() || fence.resourceKey.includes("\0")) {
    throw new Error("Workspace mutation fencing resource is invalid");
  }
  if (!Number.isSafeInteger(fence.token) || fence.token <= 0) {
    throw new Error("Workspace mutation fencing token is invalid");
  }
};

export const serializeWorkspaceWriterFence = (fence: WorkspaceWriterFence): string => {
  validateFence(fence);
  return JSON.stringify([fence.resourceKey, fence.token]);
};

export const createWorkspaceMutationFence = async (
  storageRoot: string,
  options: WorkspaceMutationFenceOptions,
): Promise<WorkspaceMutationFence> => {
  validateFence(options);
  mkdirSync(storageRoot, { recursive: true });
  const database = openSqliteDatabase(
    path.join(storageRoot, "workspace-mutation-fence.sqlite"),
    (value) => {
      value.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS workspace_mutation_fence (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          token INTEGER NOT NULL DEFAULT 0
        );
      `);
      const columns = new Set(
        (value.prepare("PRAGMA table_info(workspace_mutation_fence)").all() as Array<Record<string, unknown>>)
          .map((row) => String(row.name)),
      );
      if (!columns.has("resource_key")) {
        value.exec("ALTER TABLE workspace_mutation_fence ADD COLUMN resource_key TEXT NOT NULL DEFAULT ''");
      }
      if (!columns.has("fence_token")) {
        value.exec("ALTER TABLE workspace_mutation_fence ADD COLUMN fence_token INTEGER NOT NULL DEFAULT 0");
      }
    },
    { busyTimeoutMs: 100 },
  );
  const timeoutMs = Math.max(1_000, options.acquisitionTimeoutMs ?? 30_000);
  let queue = Promise.resolve();
  let disposed = false;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const beginImmediate = async (): Promise<void> => {
    const deadlineAt = performance.now() + timeoutMs;
    let attempt = 0;
    let lastError: unknown;
    while (performance.now() < deadlineAt) {
      try {
        database.exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        lastError = error;
        if (!isSqliteContentionError(error)) {
          throw error;
        }
        attempt += 1;
        await delay(Math.min(100, 5 * attempt));
      }
    }
    throw new Error("Timed out waiting for the workspace mutation fence", {
      cause: lastError,
    });
  };

  const activate = (): Promise<void> => enqueue(async () => {
    options.assertWritable?.();
    await beginImmediate();
    try {
      options.assertWritable?.();
      const current = database.prepare(`
        SELECT resource_key AS resourceKey, fence_token AS token
        FROM workspace_mutation_fence
        WHERE singleton = 1
      `).get() as WorkspaceWriterFence | undefined;
      if (
        !options.assertWritable &&
        current?.resourceKey === options.resourceKey &&
        current.token > options.token
      ) {
        throw new Error("Workspace mutation ownership was already replaced by a newer writer");
      }
      database.prepare(`
        INSERT INTO workspace_mutation_fence(singleton, token, resource_key, fence_token)
        VALUES(1, 0, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          token = 0,
          resource_key = excluded.resource_key,
          fence_token = excluded.fence_token
      `).run(options.resourceKey, options.token);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database, error);
    }
  });

  await activate();

  const run: WorkspaceMutationRunner = <T>(operation: () => Promise<T>): Promise<T> =>
    enqueue(async () => {
      if (disposed) {
        throw new Error("Workspace mutation fence is disposed");
      }
      options.assertWritable?.();
      await beginImmediate();
      try {
        const current = database.prepare(`
          SELECT resource_key AS resourceKey, fence_token AS token
          FROM workspace_mutation_fence
          WHERE singleton = 1
        `).get() as WorkspaceWriterFence | undefined;
        if (
          !current ||
          current.resourceKey !== options.resourceKey ||
          current.token !== options.token
        ) {
          throw new Error("Bachata workspace writer lease is stale");
        }
        options.assertWritable?.();
        const result = await operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        return rollback(database, error);
      }
    });

  return {
    run,
    dispose: () => enqueue(async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      database.close();
    }),
  };
};
