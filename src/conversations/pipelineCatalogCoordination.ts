import { resolve } from "node:path";

/**
 * EX-3. What coordinating the pipeline catalog decides, apart from the filesystem it coordinates.
 *
 * Catalog writes take an ownership lease keyed by directory, run one at a time, and are followed
 * by a release that can fail on its own. Watching the catalog is the mirror of that: which
 * locations are watched, how long a burst of file events is allowed to settle, and whether an
 * event still means anything once the manager is disposed. The lease, the watcher and the
 * filesystem stay with the caller; which directory is the same directory, what a doubly failed
 * mutation reports, and what is watched are decided here.
 */

/**
 * The identity two mutations must share to exclude each other.
 *
 * Windows paths are compared case-insensitively because the filesystem is: two spellings of one
 * directory that hashed differently would let two writers own the same catalog at once. Every
 * other platform keeps the path as written, because there the two spellings are two directories.
 */
export const catalogOwnershipIdentity = (
  catalogDirectory: string,
  platform: string = process.platform,
): string =>
  platform === "win32"
    ? resolve(catalogDirectory).toLowerCase()
    : resolve(catalogDirectory);

/**
 * What a mutation reports when the write failed, the ownership release failed, or both.
 *
 * Both failures travel together: a release that could not be confirmed leaves the catalog owned by
 * a writer that is gone, and reporting only the write failure would lose that. Neither is
 * swallowed, and a mutation that succeeded cleanly reports nothing.
 */
export const catalogMutationFailure = (input: {
  operationError?: unknown;
  releaseError?: unknown;
}): unknown => {
  if (input.operationError !== undefined && input.releaseError !== undefined) {
    return new AggregateError(
      [input.operationError, input.releaseError],
      "Pipeline catalog mutation failed and ownership cleanup also failed",
    );
  }
  if (input.operationError !== undefined) return input.operationError;
  return input.releaseError;
};

/** How long a burst of catalog file events is allowed to settle before one refresh runs. */
export const PIPELINE_CATALOG_REFRESH_DEBOUNCE_MS = 100;

/**
 * What a catalog file event schedules.
 *
 * A disposed manager has no runtimes left to refresh, so its events schedule nothing — a timer it
 * armed would outlive the thing it refreshes. Otherwise the pending refresh is cancelled and
 * rearmed, so a rename, a bulk checkout or an editor writing several catalog files produces one
 * reload rather than one per file.
 */
export const catalogRefreshSchedule = (input: {
  disposed: boolean;
  refreshPending: boolean;
}): { schedule: boolean; cancelPending: boolean } =>
  input.disposed
    ? { schedule: false, cancelPending: false }
    : { schedule: true, cancelPending: input.refreshPending };

export type CatalogWatchPattern = { base: string; glob: string };

/**
 * Where catalog files are watched: each workspace root's own repository catalog, and the shared
 * catalog under the extension's storage. A root that appears twice is watched once — the second
 * watcher would deliver a second event for the same write, and every event schedules a refresh.
 */
export const catalogWatchPatterns = (input: {
  workspaceRoots: readonly string[];
  sharedDirectory: string;
}): CatalogWatchPattern[] => [
  ...Array.from(new Set(input.workspaceRoots), (root) => ({
    base: root,
    glob: ".bachata/pipelines/*.pipeline.json",
  })),
  { base: input.sharedDirectory, glob: "*.pipeline.json" },
];

/**
 * What a catalog refresh says when one runtime's reload failed. The refresh is fan-out: every
 * other runtime still reloaded, so each failure is reported on its own rather than ending the
 * sweep at the first one.
 */
export const catalogRefreshFailureMessages = (
  results: readonly PromiseSettledResult<unknown>[],
): string[] =>
  results.flatMap((result) =>
    result.status === "rejected"
      ? [
          `Pipeline catalog refresh failed: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        ]
      : [],
  );
