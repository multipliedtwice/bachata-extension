import { existsSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createLongitudinalStore } from "./longitudinalStore";
import type { LongitudinalStore } from "./longitudinalStore";
import {
  readCatalogActiveRunRef,
  readCatalogEvents,
  readCatalogRuns,
} from "./catalogReads";
import type { CatalogEventRecord } from "./catalogReads";
import type { RunCatalogRecord } from "./catalog";
import { EMPTY_LONGITUDINAL_SNAPSHOT } from "../longitudinal/types";
import { createLongitudinalService, emptyLongitudinalSummary } from "../longitudinal/service";
import type { LongitudinalService, LongitudinalSummary } from "../longitudinal/service";

/**
 * The longitudinal surface a read-only window is given. Every mutating method of the writer's
 * store is absent here, so a secondary window cannot reach one even by mistake; the SQLite
 * handle underneath is opened read-only as well, so a write would also be refused by the file.
 */
export type ReadOnlyLongitudinalStore = Pick<
  LongitudinalStore,
  | "listInitiatives"
  | "listInitiativesByRepository"
  | "getInitiative"
  | "findInitiativeByRepository"
  | "activeInitiativeId"
  | "listCycles"
  | "cycleForRun"
  | "listArtifacts"
  | "listDecisions"
  | "listFindingHistory"
  | "listFindingAliases"
  | "listFixRuns"
  | "fixRunsForRun"
  | "listRounds"
  | "runBinding"
  | "snapshot"
>;

export type ReadOnlyStateCatalog = {
  path: string;
  /** False when the writer has never created the catalog: a reader must not create it. */
  present: boolean;
  /** Why the catalog could not be read, when it exists but could not be opened. */
  unavailable?: string;
  longitudinal: ReadOnlyLongitudinalStore;
  listRuns: (includeArchived?: boolean) => RunCatalogRecord[];
  getActiveRunRef: () => string | undefined;
  listEvents: (runRef: string, limit?: number) => CatalogEventRecord[];
  /**
   * Direction, cycles, decisions and findings, projected by the same service the writer uses
   * so a secondary window renders the writer's longitudinal state rather than a copy of it.
   */
  longitudinalSummary: (repositoryRoot?: string) => LongitudinalSummary;
  close: () => void;
};

const READ_ONLY_LONGITUDINAL_METHODS = [
  "listInitiatives",
  "listInitiativesByRepository",
  "getInitiative",
  "findInitiativeByRepository",
  "activeInitiativeId",
  "listCycles",
  "cycleForRun",
  "listArtifacts",
  "listDecisions",
  "listFindingHistory",
  "listFindingAliases",
  "listFixRuns",
  "fixRunsForRun",
  "listRounds",
  "runBinding",
  "snapshot",
] as const;

const readOnlyLongitudinal = (store: LongitudinalStore): ReadOnlyLongitudinalStore =>
  Object.fromEntries(
    READ_ONLY_LONGITUDINAL_METHODS.map((name) => [name, store[name]]),
  ) as unknown as ReadOnlyLongitudinalStore;

const absentLongitudinal = (): ReadOnlyLongitudinalStore => ({
  listInitiatives: () => [],
  listInitiativesByRepository: () => [],
  getInitiative: () => undefined,
  findInitiativeByRepository: () => undefined,
  activeInitiativeId: () => undefined,
  listCycles: () => [],
  cycleForRun: () => undefined,
  listArtifacts: () => [],
  listDecisions: () => [],
  listFindingHistory: () => [],
  listFindingAliases: () => [],
  listFixRuns: () => [],
  fixRunsForRun: () => [],
  listRounds: () => [],
  runBinding: () => undefined,
  snapshot: () => structuredClone(EMPTY_LONGITUDINAL_SNAPSHOT),
});

export const READ_ONLY_CATALOG_FILENAME = "bachata-state.sqlite";

/**
 * Opens the writer's catalog for reading only.
 *
 * The handle is opened with SQLite's read-only mode, so no migration runs, no table is
 * created, no pragma that needs a write is issued, and the file's bytes cannot change. A
 * catalog the writer has not created yet is reported absent rather than being created here.
 */
export const openReadOnlyStateCatalog = (storageRoot: string): ReadOnlyStateCatalog => {
  const databasePath = path.join(storageRoot, READ_ONLY_CATALOG_FILENAME);
  const unreadable = (reason?: string): ReadOnlyStateCatalog => ({
    path: databasePath,
    present: false,
    ...(reason === undefined ? {} : { unavailable: reason }),
    longitudinal: absentLongitudinal(),
    listRuns: () => [],
    getActiveRunRef: () => undefined,
    listEvents: () => [],
    longitudinalSummary: () => emptyLongitudinalSummary(),
    close: () => undefined,
  });
  if (!existsSync(databasePath)) return unreadable();
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    // A busy timeout is a property of this connection, not of the file: it needs no write.
    database.exec("PRAGMA busy_timeout = 2000");
  } catch (error) {
    // A catalog written in WAL mode can be unreadable until its writer reopens it. The
    // window still opens, and says which section it could not read.
    return unreadable(
      `The Bachata catalog at ${databasePath} could not be opened for reading: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const guarded = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      // A catalog written by a newer writer, or one mid-migration, must not take the
      // window down: the section it feeds renders empty instead.
      return fallback;
    }
  };
  const store = createLongitudinalStore(database, () => {
    throw new Error("A read-only window cannot write longitudinal state");
  });
  const readers = new Map<string, LongitudinalService>();
  const reader = (repositoryRoot?: string): LongitudinalService => {
    const key = repositoryRoot ?? "";
    const existing = readers.get(key);
    if (existing) return existing;
    const created = createLongitudinalService({
      store,
      ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
      // A read-only window records nothing, so it never needs to mint an identifier.
      createId: () => {
        throw new Error("A read-only window cannot create a longitudinal record");
      },
    });
    readers.set(key, created);
    return created;
  };
  return {
    path: databasePath,
    present: true,
    longitudinal: readOnlyLongitudinal(store),
    longitudinalSummary: (repositoryRoot) =>
      guarded(() => reader(repositoryRoot).summary(), emptyLongitudinalSummary()),
    listRuns: (includeArchived = true) =>
      guarded(() => readCatalogRuns(database, includeArchived), []),
    getActiveRunRef: () => guarded(() => readCatalogActiveRunRef(database), undefined),
    listEvents: (runRef, limit = 500) =>
      guarded(() => readCatalogEvents(database, runRef, limit), []),
    close: () => {
      try {
        database.close();
      } catch {
        // A handle already closed by an earlier dispose is not a failure to report.
      }
    },
  };
};
