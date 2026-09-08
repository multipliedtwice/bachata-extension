import { pathInsideRelative } from "../process/pathBoundary";

export type ConversationDeletionEntry = {
  original: string;
  staged: string;
};

export type ConversationDeletionRuntimeValue = {
  storageKey: string;
  present: boolean;
  value?: unknown;
};

/**
 * What a staged conversation deletion promises to be able to undo: the run references it removed
 * from the catalog, every storage path it moved aside, and the workspace-state values it cleared.
 */
export type ConversationDeletionManifest = {
  version: 1;
  runRefs: string[];
  entries: ConversationDeletionEntry[];
  runtimeValues: ConversationDeletionRuntimeValue[];
};

export type StagedConversationDeletion = {
  directory: string;
  manifest: ConversationDeletionManifest;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strictly inside: a path equal to the root is not a member of it. */
export const isPathInside = (root: string, value: string): boolean => {
  const relative = pathInsideRelative(root, value);
  return relative !== undefined && relative !== "";
};

/** At the root or under it, which is what a trash directory has to exclude. */
export const isPathAtOrInside = (root: string, value: string): boolean =>
  pathInsideRelative(root, value) !== undefined;

export type DeletionManifestPolicy = {
  storageRoot: string;
  trashRoot: string;
  stagedRoot: string;
  isRuntimeStorageKey: (storageKey: string) => boolean;
  isRunReference: (runRef: string) => boolean;
};

/**
 * A deletion manifest is read back from disk after a crash, so it is treated as untrusted input:
 * it decides which paths a restore will write to, and a forged one would name any path on the
 * machine. Every entry must move a path strictly inside this workspace's storage back from a path
 * strictly inside this manifest's own staging directory, and no entry may name the trash root
 * itself, which is how a restore would be tricked into unstaging the staging area.
 *
 * The check is all-or-nothing. Dropping the entries that fail and restoring the rest would half-
 * undo a deletion, leaving a conversation whose storage exists and whose catalog rows do not; a
 * manifest with even one unusable entry is refused whole, and the caller reports it.
 */
export const parseDeletionManifest = (
  value: unknown,
  policy: DeletionManifestPolicy,
): ConversationDeletionManifest | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.runRefs) ||
    !value.runRefs.every((item) => typeof item === "string") ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.runtimeValues)
  ) {
    return undefined;
  }
  const entries = value.entries.flatMap((item) =>
    isRecord(item) &&
    typeof item.original === "string" &&
    typeof item.staged === "string" &&
    isPathInside(policy.storageRoot, item.original) &&
    !isPathAtOrInside(policy.trashRoot, item.original) &&
    isPathInside(policy.stagedRoot, item.staged)
      ? [{ original: item.original, staged: item.staged }]
      : [],
  );
  const runtimeValues = value.runtimeValues.flatMap((item) =>
    isRecord(item) &&
    typeof item.storageKey === "string" &&
    policy.isRuntimeStorageKey(item.storageKey) &&
    typeof item.present === "boolean"
      ? [{
          storageKey: item.storageKey,
          present: item.present,
          ...(item.present ? { value: item.value } : {}),
        }]
      : [],
  );
  const runRefs = value.runRefs as string[];
  if (
    entries.length !== value.entries.length ||
    runtimeValues.length !== value.runtimeValues.length ||
    runRefs.some((runRef) => !policy.isRunReference(runRef)) ||
    new Set(entries.map((item) => item.original)).size !== entries.length ||
    new Set(entries.map((item) => item.staged)).size !== entries.length ||
    new Set(runtimeValues.map((item) => item.storageKey)).size !== runtimeValues.length
  ) {
    return undefined;
  }
  return { version: 1, runRefs, entries, runtimeValues };
};

/**
 * Which staged entries a restore will move back, decided before anything is moved.
 *
 * Entries are examined in reverse of the order they were staged, so a directory is considered
 * after everything staged out of it. A path that exists in both places is ambiguous — restoring
 * would overwrite whatever took its place — and a path that exists in neither has lost the copy
 * the restore was supposed to return. Both refuse, and they refuse before the first rename, so a
 * restore never half-completes and leaves storage in a state neither the deletion nor the restore
 * describes.
 */
export const plannedRestoreEntries = async (
  manifest: ConversationDeletionManifest,
  pathExists: (value: string) => Promise<boolean>,
): Promise<ConversationDeletionEntry[]> => {
  const planned: ConversationDeletionEntry[] = [];
  for (const entry of [...manifest.entries].reverse()) {
    const stagedExists = await pathExists(entry.staged);
    const originalExists = await pathExists(entry.original);
    if (stagedExists && originalExists) {
      throw new Error(
        `Cannot restore deleted run storage because ${entry.original} already exists`,
      );
    }
    if (!stagedExists && !originalExists) {
      throw new Error(
        `Cannot restore deleted run storage because ${entry.original} and its staged copy are both missing`,
      );
    }
    if (stagedExists) {
      planned.push(entry);
    }
  }
  return planned;
};

/**
 * What to do with one staged deletion found on disk at startup. A deletion whose runs are still in
 * the catalog never completed, so its storage is put back; one whose runs are gone did complete,
 * so the staging directory is the only thing left to remove.
 */
export const stagedDeletionDisposition = (
  manifest: ConversationDeletionManifest,
  runIsInCatalog: (runRef: string) => boolean,
): "restore" | "discard" =>
  manifest.runRefs.some(runIsInCatalog) ? "restore" : "discard";
