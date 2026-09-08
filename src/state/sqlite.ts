import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

export type SqliteOpenOptions = {
  deadlineMs?: number;
  busyTimeoutMs?: number;
};

const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export const isSqliteContentionError = (error: unknown): boolean => {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown };
  if (value.code === "SQLITE_BUSY" || value.code === "SQLITE_LOCKED") {
    return true;
  }
  if (value.code === "ERR_SQLITE_ERROR" && (value.errcode === 5 || value.errcode === 6)) {
    return true;
  }
  return typeof value.message === "string" && /database (?:is )?locked|database table is locked/iu.test(value.message);
};

const sleepSync = (milliseconds: number): void => {
  Atomics.wait(waitBuffer, 0, 0, Math.max(1, Math.floor(milliseconds)));
};


export const withImmediateTransaction = <T>(
  database: DatabaseSync,
  operation: () => T,
): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "SQLite operation failed and its rollback could not be confirmed",
      );
    }
    throw error;
  }
};

export const openSqliteDatabase = (
  databasePath: string,
  initialize: (database: DatabaseSync) => void,
  options: SqliteOpenOptions = {},
): DatabaseSync => {
  const deadlineMs = Math.max(1_000, options.deadlineMs ?? 10_000);
  const deadlineAt = performance.now() + deadlineMs;
  const busyTimeoutMs = Math.max(1, options.busyTimeoutMs ?? 5_000);
  let attempt = 0;
  let lastError: unknown;
  while (performance.now() < deadlineAt) {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
      initialize(database);
      return database;
    } catch (error) {
      lastError = error;
      try {
        database?.close();
      } catch {
        // EX-AUD-13. The open already failed; `lastError` holds why. A half-open handle
        // refusing to close must not replace the error the caller needs to see.
      }
      if (!isSqliteContentionError(error)) {
        throw error;
      }
      attempt += 1;
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) {
        break;
      }
      sleepSync(Math.min(remaining, 20 * attempt));
    }
  }
  throw new Error(
    `Timed out initializing SQLite database ${databasePath}`,
    { cause: lastError },
  );
};
