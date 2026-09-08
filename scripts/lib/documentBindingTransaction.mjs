import { randomUUID } from "node:crypto";
import { constants, link, open, readFile, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { openVerifiedRegularFile } from "./verifiedRegularFile.mjs";

export const LOCK_NAME = ".bachata-bind.lock";
export const JOURNAL_NAME = ".bachata-bind.journal.json";

const DEFAULT_DOCUMENT_MODE = 0o644;

const noFollowRead = async (file) => {
  const { handle, details } = await openVerifiedRegularFile(file);
  try {
    return {
      contents: (await handle.readFile()).toString("utf8"),
      mode: Number(details.mode & 0o7777n),
      dev: details.dev,
      ino: details.ino,
    };
  } finally {
    await handle.close();
  }
};

const writeExclusive = async (file, contents, mode) => {
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (directory) => {
  try {
    const handle = await open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every platform; the renames themselves
    // are still atomic, and the journal records what must be recovered.
  }
};

const processIsRunning = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error && error.code) === "EPERM";
  }
};

const readJournal = async (journalFile) => {
  const source = await readFile(journalFile, "utf8").catch((error) => {
    if ((error && error.code) === "ENOENT") return undefined;
    throw error;
  });
  if (source === undefined) return undefined;
  try {
    const value = JSON.parse(source);
    return Array.isArray(value?.entries) ? value : undefined;
  } catch {
    return { entries: [], unreadable: true };
  }
};

export const recoverDocumentBinding = async (docsDirectory) => {
  const journalFile = path.join(docsDirectory, JOURNAL_NAME);
  const journal = await readJournal(journalFile);
  if (!journal) return { recovered: [], failures: [] };
  if (journal.unreadable) {
    return {
      recovered: [],
      failures: [`${journalFile} is not readable JSON; restore the documents by hand and remove it`],
    };
  }
  const recovered = [];
  const failures = [];
  for (const entry of journal.entries) {
    try {
      const backup = await stat(entry.backup).catch(() => undefined);
      if (backup) {
        await rename(entry.backup, entry.file);
        recovered.push(entry.relative);
      }
      await rm(entry.staged, { force: true });
    } catch (error) {
      failures.push(
        `${entry.relative}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length === 0) {
    await syncDirectory(docsDirectory);
    await rm(journalFile, { force: true });
  }
  return { recovered, failures };
};

/**
 * EX-A5-R16. The lock is the `lock` link, and the thing that can be retired is the holder's own
 * proof beside it.
 *
 * The lock used to be a single exclusively-created file, and reclamation read its owner, judged
 * that owner dead, and then removed the file. Those are two steps: between them the owner's own
 * run could finish and a new binder could take the lock, and the delayed reclaimer then deleted
 * a live binder's lock and let a third binder in on top of a running transaction, which journal
 * recovery would then roll back.
 *
 * So a holder writes a proof named for its own instance and hard-links `lock` to it. Retiring
 * renames THE PROOF, not the link: a rename naming an instance that no longer holds fails
 * `ENOENT` and has touched nothing, and `lock` stays linked throughout, so the slot is never
 * observably free while a holder is live. Only the caller whose rename succeeded, and only while
 * `lock` still names that instance, may unlink it.
 */
const proofPath = (lockFile, instance) => `${lockFile}.${instance}.owner`;

export const acquireLockInstance = async (lockFile) => {
  const instance = randomUUID();
  const proof = proofPath(lockFile, instance);
  const handle = await open(
    proof,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    // Written in full before it is linked, so `lock` never names a half-written record.
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, instance })}\n`, "utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await link(proof, lockFile);
  } catch (error) {
    await rm(proof, { force: true }).catch(() => undefined);
    throw error;
  }
  return instance;
};

export const retireLockInstance = async (lockFile, instance) => {
  if (typeof instance !== "string" || instance.length === 0) return false;
  const retired = `${lockFile}.${randomUUID()}.retired`;
  try {
    // The rename IS the check.
    await rename(proofPath(lockFile, instance), retired);
  } catch {
    return false;
  }
  const owner = await heldLockOwner(lockFile);
  const held = owner?.instance === instance;
  if (held) {
    await rm(lockFile, { force: true }).catch(() => undefined);
  }
  await rm(retired, { force: true }).catch(() => undefined);
  return held;
};

export const heldLockOwner = async (lockFile) => {
  const source = await readFile(lockFile, "utf8").catch(() => "");
  try {
    const value = JSON.parse(source);
    if (!Number.isInteger(value?.pid)) return undefined;
    return {
      pid: value.pid,
      ...(typeof value.instance === "string" && value.instance ? { instance: value.instance } : {}),
    };
  } catch {
    const legacy = Number.parseInt(source.trim(), 10);
    return Number.isInteger(legacy) ? { pid: legacy } : undefined;
  }
};

/**
 * Stages every pending document, records a recovery journal, then renames each staged
 * file into place. A failure at any phase restores every document this run touched and
 * reports whatever could not be restored. The lock is always released; a journal that
 * could not be replayed is deliberately left behind for the next run to recover.
 */
export const bindDocuments = async ({ docsDirectory, plans, hooks = {} }) => {
  const lockFile = path.join(docsDirectory, LOCK_NAME);
  const journalFile = path.join(docsDirectory, JOURNAL_NAME);

  /*
   * EX-G6-15. Recovery is a mutation: it replays a journal and restores the documents that
   * journal names. Running it before taking the lock meant a competing binder that was mid
   * transaction — holding the lock, its journal on disk — had its writes rolled back by a
   * newcomer that then discovered the lock was held and refused. The refusal was reported
   * politely; the damage was already done.
   *
   * Ownership first, then recovery. Whatever journal is found afterwards belongs to a
   * transaction that is provably not running, because this run holds the lock that a running
   * one would hold.
   */
  let heldInstance;
  try {
    heldInstance = await acquireLockInstance(lockFile);
  } catch (error) {
    if ((error && error.code) !== "EEXIST") throw error;
    const owner = await heldLockOwner(lockFile);
    // A lock is only cleared when this run can prove its owner is gone. An unreadable
    // lock names no owner, so it stays held and the binding refuses: fail closed.
    // EX-A5-R16. A lock with no instance is one an older build wrote, and there is no proof
    // beside it to retire, so it cannot be reclaimed safely either. It is refused the same way.
    const blocked = (reason) => ({ status: "blocked", reasons: [reason], recovered: [] });
    if (owner === undefined || processIsRunning(owner.pid)) {
      return blocked(owner === undefined
        ? `Another binding operation holds ${lockFile}, and the lock names no process. Remove it by hand if no binder is running.`
        : `Another binding operation (pid ${String(owner.pid)}) holds ${lockFile}. Wait for it to finish.`);
    }
    if (owner.instance === undefined) {
      // EX-A5-R16. A lock an older build wrote has no proof beside it to retire, so the only
      // reclaim available is removing the file. What makes that safe here is that every lock
      // this build takes carries an instance: an owner record read immediately before the
      // removal that still has none cannot be a binder that took the lock in the meantime.
      const still = await heldLockOwner(lockFile);
      if (still === undefined || still.instance !== undefined || still.pid !== owner.pid || processIsRunning(still.pid)) {
        return blocked(`Another binding operation took ${lockFile} while this run was reclaiming it. Try again.`);
      }
      await rm(lockFile, { force: true });
    } else if (!(await retireLockInstance(lockFile, owner.instance))) {
      // Take exactly the instance that was judged, or take nothing: the lock may have changed
      // hands while this run was deciding, and the new holder's transaction is live.
      return blocked(`Another binding operation took ${lockFile} while this run was reclaiming it. Try again.`);
    }
    heldInstance = await acquireLockInstance(lockFile);
  }

  const recovery = await recoverDocumentBinding(docsDirectory);
  if (recovery.failures.length > 0) {
    await retireLockInstance(lockFile, heldInstance);
    return { status: "blocked", reasons: recovery.failures, recovered: recovery.recovered };
  }

  const staged = [];
  let journalWritten = false;
  try {
    for (const plan of plans) {
      const identifier = randomUUID();
      const record = {
        plan,
        relative: plan.relative,
        file: plan.file,
        staged: `${plan.file}.${identifier}.bachata-bind`,
        backup: `${plan.file}.${identifier}.bachata-bind-backup`,
        committed: false,
        backedUp: false,
        stagedWritten: false,
      };
      // Registered before anything is created, so a failure part-way through the write
      // still leaves a name this run knows how to remove.
      staged.push(record);
      const current = await noFollowRead(plan.file);
      if (current.contents !== plan.original) {
        throw new Error(`${plan.relative} changed while this binding was being planned`);
      }
      record.mode = current.mode || DEFAULT_DOCUMENT_MODE;
      record.dev = current.dev;
      record.ino = current.ino;
      await hooks.beforeStage?.(record);
      await writeExclusive(record.backup, current.contents, record.mode);
      record.backedUp = true;
      await writeExclusive(record.staged, plan.next, record.mode);
      record.stagedWritten = true;
      await hooks.afterStage?.(record);
    }

    await hooks.beforeJournal?.(staged);
    await writeExclusive(
      journalFile,
      `${JSON.stringify({
        pid: process.pid,
        entries: staged.map((record) => ({
          relative: record.relative,
          file: record.file,
          staged: record.staged,
          backup: record.backup,
        })),
      }, undefined, 2)}\n`,
      0o600,
    );
    journalWritten = true;
    await syncDirectory(docsDirectory);

    for (const record of staged) {
      await hooks.beforeRename?.(record);
      // Identity is re-checked here, immediately before the rename, not once at planning
      // time: a document edited during staging must not be silently overwritten.
      const current = await noFollowRead(record.file);
      if (
        current.contents !== record.plan.original ||
        current.dev !== record.dev ||
        current.ino !== record.ino
      ) {
        throw new Error(`${record.relative} changed while this binding was being staged`);
      }
      await rename(record.staged, record.file);
      record.committed = true;
      await hooks.afterRename?.(record);
    }
    await syncDirectory(docsDirectory);

    for (const record of staged) {
      await rm(record.backup, { force: true });
    }
    await rm(journalFile, { force: true });
    journalWritten = false;
    return { status: "bound", written: staged, recovered: recovery.recovered };
  } catch (error) {
    const rollbackFailures = [];
    for (const record of staged) {
      try {
        await hooks.beforeRollback?.(record);
        if (record.committed) {
          // Rename, not writeFile: the restore is atomic, never follows a replacement
          // symbolic link, and carries the document's original mode back with it.
          await rename(record.backup, record.file);
          record.committed = false;
        } else {
          await rm(record.staged, { force: true });
          await rm(record.backup, { force: true });
        }
      } catch (rollbackError) {
        rollbackFailures.push(
          `${record.relative}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    await syncDirectory(docsDirectory);
    if (rollbackFailures.length === 0 && journalWritten) {
      await rm(journalFile, { force: true }).catch(() => undefined);
    }
    return {
      status: rollbackFailures.length > 0 ? "unrecovered" : "rolled-back",
      error,
      rollbackFailures,
      journal: journalWritten && rollbackFailures.length > 0 ? journalFile : undefined,
      recovered: recovery.recovered,
    };
  } finally {
    // EX-A5-R16. The release removes the instance this run owns, by the same rename, so a lock
    // that changed hands is not deleted out from under its new owner.
    await retireLockInstance(lockFile, heldInstance);
  }
};
