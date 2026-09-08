import { link, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const WORKTREE_LOCK_FILE = ".bachata-worktree.lock";
export const WORKTREE_LOCK_OWNER_ENVIRONMENT = "BACHATA_WORKTREE_LOCK_OWNER";
const FENCE_SUFFIX = ".fence";
const CLAIM_INFIX = ".claim-";
const RETIRED_INFIX = ".retired-";

// The canonical lock is one fixed path in this package. No environment variable redirects
// it: two commands in the same worktree that resolved different paths would both believe
// they owned it. A test fixture passes an isolated path as an argument instead.
export const defaultWorktreeLockPath = () => path.join(packageRoot, WORKTREE_LOCK_FILE);

// A second run refuses quickly instead of queueing behind a run that may last for the
// length of a full suite. `BACHATA_WORKTREE_LOCK_WAIT_MS` raises it where waiting is wanted.
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 100;
// The heartbeat is a breadcrumb for a human reading the file, not authority: nothing is
// ever reclaimed because a heartbeat stopped.
const DEFAULT_HEARTBEAT_MS = 2_000;
const FENCE_HEARTBEAT_MS = 500;
// Releasing must not abandon a lock merely because a reclaim is in flight, so it waits far
// longer for the fence than an acquirer does before giving up on deleting.
const RELEASE_FENCE_WAIT_MS = 30_000;

/*
 * Ownership invariants. Each is exercised by a test in tests/worktreeLock.test.cjs.
 *
 * 1. Ownership is conferred only by exclusive publication of the canonical lock path: a
 *    private claim is written and synced first, then linked into place atomically, so a
 *    crash can leave a claim but never an unreadable canonical lock.
 * 2. Ownership is never transferred. Not by age, not by heartbeat, not by proving the
 *    recorded process dead, not by a signal, and not by ordinary process exit. The work a
 *    lock protects runs in a tree — re-entrant children, and compilers and test runners
 *    that never call this module — so nothing this module can observe proves that work
 *    stopped. A lock ends in exactly two ways: its owner releases it after the work
 *    finishes, or an operator clears it with `npm run worktree:unlock -- LOCK_TOKEN`.
 * 3. The canonical lock path is renamed or unlinked only by a run holding the fence, won
 *    by link() of a private claim onto the fence path: link is atomic and refuses an
 *    existing target, so it has exactly one winner.
 * 4. A fence may be retired on proof that its holder is dead, because a fence holder
 *    delegates nothing: a dead one cannot resume its half-finished delete. A fence has no
 *    deadline, so a living holder's authority cannot lapse mid-operation.
 * 5. Creating the file is not ownership. A run confirms, after publishing and after any
 *    fence clears, that the canonical path is still its own file. The only file it ever
 *    deletes is that one, through the same fenced, identity-proved removal release uses.
 * 6. Identity of "its own file" always requires the recorded token to match — tokens are
 *    random per acquisition and only their own run writes them — and requires the inode to
 *    match as well wherever both sides have a usable one. A matching inode is never
 *    sufficient on its own: inode numbers are reused after a delete and a create, so a
 *    replacement can present the number its predecessor had. The same rule governs locks,
 *    fences, release and diagnostics.
 * 7. A file already moved off the canonical path cannot make two runs owners, so retiring
 *    it is safe. A file that is not the judged one is put back, and when restoration is
 *    refused it is left in place rather than deleted.
 *
 * The cost is stated plainly: a run killed with SIGKILL, or ended by a signal it does not
 * handle, leaves its lock behind and the next run refuses until an operator clears it.
 * That is the price of never handing a worktree to a second run while the first run's
 * descendants may still be writing to it.
 */

const numberFromEnvironment = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const ignoreMissing = (error) => {
  if (error?.code === "ENOENT") return undefined;
  throw error;
};

const NO_HOOKS = {};

// Test-only barriers. Production passes no hooks, so every call is a no-op.
const runHook = async (hooks, name) => {
  const hook = hooks?.[name];
  if (typeof hook === "function") await hook();
};

// A record that cannot be read or parsed is never evidence of a dead owner: a run that has
// created its file but not yet written it reads back as empty, so only the file's own
// heartbeat may retire it.
const readRecord = async (candidate) => {
  const raw = await readFile(candidate, "utf8").catch(ignoreMissing);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.token === "string" && parsed.token.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The single authority rule: a record may be retired only when it names a process on this
 * host that is proven gone. A live process, another host, a missing pid, and a record that
 * cannot be read all fail closed — none of them may lose the worktree.
 *
 * Process ids are recycled, so a recycled id makes a dead owner look alive. That errs
 * toward refusing, never toward taking a worktree away.
 */
const ownerIsProvablyDead = (record) => {
  if (typeof record?.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) {
    return false;
  }
  if (record.host !== hostname()) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    // EPERM proves the process exists and belongs to another user.
    return error?.code === "ESRCH";
  }
};

const usableInode = (details) => Boolean(details) && Number.isFinite(Number(details?.ino)) && Number(details.ino) > 0;

/**
 * The one identity rule, used for locks, fences, release and recovery removal alike.
 *
 * The recorded token must always match. Tokens are random per acquisition and only their
 * own run ever writes one, so a token is the durable half of the identity. An inode is the
 * corroborating half: it is checked in addition whenever both sides have a usable one, and
 * skipped where the filesystem provides none.
 *
 * Inode equality is never sufficient on its own. Inode numbers are reused after a file is
 * deleted and another created, so a replacement can present the number the previous file
 * had; accepting that alone would let a run delete a live replacement.
 *
 * A missing file, a missing expectation, or a record that cannot be read fails closed.
 */
const identityMatches = ({ details, record }, { details: expected, token }) => {
  if (!details) return false;
  if (typeof token !== "string" || token.length === 0) return false;
  if (record?.token !== token) return false;
  if (usableInode(details) && usableInode(expected)) {
    return Number(details.ino) === Number(expected.ino);
  }
  return true;
};

// A lock whose record cannot be read carries no token to prove which file was judged.
// An inode alone is not that proof, because inodes are reused; recovery therefore also
// requires the exact bytes it judged to be the bytes it is removing. Without a stable
// inode there is no proof at all, and recovery refuses.
const unreadableIdentityMatches = ({ details, record, bytes }, expected) => {
  if (!details || !expected) return false;
  if (record !== undefined) return false;
  if (!usableInode(details) || !usableInode(expected.details)) return false;
  if (Number(details.ino) !== Number(expected.details.ino)) return false;
  if (typeof bytes !== "string" || typeof expected.bytes !== "string") return false;
  return bytes === expected.bytes;
};

const describe = (record, details) => {
  if (record) {
    return `pid ${String(record.pid ?? "unknown")} on ${String(record.host ?? "unknown host")}${
      record.label ? ` running ${String(record.label)}` : ""
    }`;
  }
  const age = details ? Math.round((Date.now() - details.mtimeMs) / 1_000) : undefined;
  return `an owner whose lock record is not readable yet${age === undefined ? "" : `, last active ${String(age)}s ago`}`;
};

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

// Identity is read through this one function. Tests replace it to reproduce a filesystem
// that reports no usable inode; production leaves it at lstat.
let readFileIdentity = async (candidate) => lstat(candidate).catch(ignoreMissing);

export const setFileIdentityReaderForTests = (reader) => {
  readFileIdentity = typeof reader === "function"
    ? reader
    : async (candidate) => lstat(candidate).catch(ignoreMissing);
};

const regularFileDetails = async (candidate, what) => {
  const details = await readFileIdentity(candidate);
  if (!details) return undefined;
  if (details.isSymbolicLink()) {
    throw new Error(`Refusing to use a symbolic link as the Bachata worktree ${what}: ${candidate}`);
  }
  if (!details.isFile()) {
    throw new Error(`Refusing to use a non-file as the Bachata worktree ${what}: ${candidate}`);
  }
  return details;
};

const recordText = (token, label, heartbeatMs) =>
  `${JSON.stringify(
    {
      token,
      pid: process.pid,
      host: hostname(),
      label,
      acquiredAt: new Date().toISOString(),
      // The rate this owner refreshes its file at. An observer with a shorter deadline than
      // the owner's heartbeat must not mistake a healthy owner for an abandoned one.
      ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    },
    undefined,
    2,
  )}\n`;

export const fencePathFor = (lockPath) => `${lockPath}${FENCE_SUFFIX}`;

// A fence is retired only when its holder is proven dead. It has no deadline, so the
// authority of a holder that is merely slow, stopped, or descheduled cannot expire while
// it is inside a destructive step. This is what makes the move below safe without a
// further round of checks: only a process that no longer exists can lose its fence, and a
// process that no longer exists is not executing anything.
const fenceIsRetirable = (record) => ownerIsProvablyDead(record);

// One read of the fence: its identity and its record together, so no decision is made from
// a mixture of two moments.
const fenceSnapshot = async (fencePath) => {
  const details = await regularFileDetails(fencePath, "fence");
  if (!details) return undefined;
  return { details, record: await readRecord(fencePath) };
};

// Invariant 7. Retiring moves the fence aside and only then deletes it, and only when the
// moved file is the one that was judged; anything else is restored and never deleted.
// `judged` is one {details, record} snapshot. Proof of death and the identity used to
// recognise the file afterwards must come from the same read: with two reads, a fence
// replaced in between can be proved dead by the first and identified by the second, and a
// live replacement is then deleted. Returns false when the file it moved was not the one
// judged, which the callers treat as "still held".
const retireDeadFence = async (fencePath, judged) => {
  const retiredPath = `${fencePath}${RETIRED_INFIX}${randomUUID()}`;
  try {
    await rename(fencePath, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const moved = await readFileIdentity(retiredPath);
  const movedRecord = await readRecord(retiredPath);
  const movedIsJudged = identityMatches(
    { details: moved, record: movedRecord },
    { details: judged.details, token: judged.record?.token },
  );
  if (moved && !movedIsJudged) {
    const restored = await link(retiredPath, fencePath).then(() => true, (error) => {
      if (error?.code !== "EEXIST") throw error;
      return false;
    });
    // A restored file has two names for one inode, so dropping the retired name removes
    // the residue without touching the fence the canonical name still holds. Restoration
    // refused by EEXIST leaves the moved copy for the sweep instead: an EEXIST is never a
    // licence to delete a file that may still be somebody's fence.
    if (restored) await rm(retiredPath, { force: true }).catch(() => undefined);
    return false;
  }
  await rm(retiredPath, { force: true }).catch(() => undefined);
  return true;
};

// The only way any run removes the canonical lock. Authority is re-proved immediately
// before the move and again after it: a run whose fence lapsed while it was stalled
// removes nothing. After the move the file is identified by invariant 6 — its recorded
// token, and its inode too where both are usable — and anything that is not the judged
// file is put back rather than deleted.
const removeFencedLock = async ({ lockPath, judged, judgedToken, judgedBytes, fence, hooks = NO_HOOKS }) => {
  await runHook(hooks, "beforeFencedRename");
  // The final proof. Invariant 4 makes it durable rather than momentary: this fence can
  // only be retired by proving this process dead, and this process is running.
  if (!(await fence.stillHeld())) return false;
  await runHook(hooks, "afterFinalProof");
  const retiredPath = `${lockPath}${RETIRED_INFIX}${randomUUID()}`;
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await runHook(hooks, "afterFencedRename");
  const moved = await readFileIdentity(retiredPath);
  const movedRecord = await readRecord(retiredPath);
  const movedBytes = judgedToken === undefined
    ? await readFile(retiredPath, "utf8").catch(ignoreMissing)
    : undefined;
  const movedIsJudged = judgedToken === undefined
    ? unreadableIdentityMatches(
      { details: moved, record: movedRecord, bytes: movedBytes },
      { details: judged, bytes: judgedBytes },
    )
    : identityMatches(
      { details: moved, record: movedRecord },
      { details: judged, token: judgedToken },
    );
  if (moved && !movedIsJudged) {
    // Not the file that was judged. Put it back, and if the canonical path has been taken
    // in the meantime leave the moved copy for the sweep: an EEXIST is never a licence to
    // delete a file that may still be somebody's lock.
    const restored = await link(retiredPath, lockPath).then(() => true, (error) => {
      if (error?.code !== "EEXIST") throw error;
      return false;
    });
    // Restoration leaves two names for one inode. Dropping the retired name removes the
    // residue; the lock itself survives under the canonical name.
    if (restored) await rm(retiredPath, { force: true }).catch(() => undefined);
    return false;
  }
  await rm(retiredPath, { force: true }).catch(() => undefined);
  return true;
};

/**
 * Wins the fence, the single primitive every destructive step goes through.
 */
const acquireFence = async ({ lockPath, label, waitMs, pollMs, hooks = NO_HOOKS }) => {
  const fencePath = fencePathFor(lockPath);
  const token = randomUUID();
  const claimPath = `${fencePath}${CLAIM_INFIX}${token}`;
  const deadline = Date.now() + waitMs;
  const handle = await open(claimPath, "wx", 0o600);
  try {
    await handle.writeFile(recordText(token, label), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(claimPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const ownedFence = await readFileIdentity(claimPath);

  const abandon = async () => {
    await handle.close().catch(() => undefined);
    await rm(claimPath, { force: true }).catch(() => undefined);
  };

  for (;;) {
    try {
      await link(claimPath, fencePath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await abandon();
        throw error;
      }
      const judged = await fenceSnapshot(fencePath);
      if (judged && fenceIsRetirable(judged.record)) {
        await runHook(hooks, "beforeFenceRetire");
        await retireDeadFence(fencePath, judged);
        continue;
      }
      if (Date.now() >= deadline) {
        await abandon();
        return undefined;
      }
      await sleep(Math.max(10, Math.min(pollMs, deadline - Date.now())));
    }
  }

  // The claim and the fence are now one inode. Dropping the claim name keeps the directory
  // clean while the open handle keeps the fence beating.
  await rm(claimPath, { force: true }).catch(() => undefined);
  const heartbeat = setInterval(() => {
    const now = new Date();
    void handle.utimes(now, now).catch(() => undefined);
  }, FENCE_HEARTBEAT_MS);
  heartbeat.unref?.();

  let released = false;
  return {
    token,
    path: fencePath,
    // Proof that this run still holds the fence, re-read from disk. A fence that expired
    // and was retired under a stalled holder revokes that holder's authority immediately.
    stillHeld: async () => {
      if (released) return false;
      const current = await readFileIdentity(fencePath);
      const record = await readRecord(fencePath);
      return identityMatches({ details: current, record }, { details: ownedFence, token });
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await runHook(hooks, "beforeFenceRelease");
      const current = await readFileIdentity(fencePath);
      const record = await readRecord(fencePath);
      if (identityMatches({ details: current, record }, { details: ownedFence, token })) {
        await rm(fencePath, { force: true }).catch(() => undefined);
      }
      await handle.close().catch(() => undefined);
    },
  };
};

// A fence whose holder is gone blocks nobody, and it is retired through the same safe
// move-then-verify path a fence acquirer uses, so an abandoned one leaves no residue.
const fenceIsHeld = async (lockPath, hooks = NO_HOOKS) => {
  const fencePath = fencePathFor(lockPath);
  const judged = await fenceSnapshot(fencePath);
  if (!judged) return false;
  if (!fenceIsRetirable(judged.record)) return true;
  // The seam between proving the fence dead and retiring it. Tests replace the fence here.
  await runHook(hooks, "beforeFenceRetire");
  // Retirement reports whether it removed the fence it judged. When it found something
  // else there instead, that something is live and this reports the fence as held.
  return !(await retireDeadFence(fencePath, judged));
};


/**
 * One worktree-wide exclusive lock. Build, unit tests, coverage, watch, packaging and the
 * gates that load the built tree all read or delete `dist`, so a second run waits briefly
 * and then refuses rather than deleting the tree the first one is using. Ownership is
 * inherited: a child process carrying the owner token re-enters instead of deadlocking.
 */
export const acquireWorktreeLock = async ({
  label = "worktree operation",
  lockPath = defaultWorktreeLockPath(),
  waitMs = numberFromEnvironment("BACHATA_WORKTREE_LOCK_WAIT_MS", DEFAULT_WAIT_MS),
  heartbeatMs = numberFromEnvironment("BACHATA_WORKTREE_LOCK_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
  pollMs = DEFAULT_POLL_MS,
  environment = process.env,
  hooks = NO_HOOKS,
  log = (message) => process.stdout.write(`${message}\n`),
} = {}) => {
  const inheritedToken = environment[WORKTREE_LOCK_OWNER_ENVIRONMENT];
  if (inheritedToken) {
    const record = await readRecord(lockPath);
    if (record?.token === inheritedToken) {
      return { token: inheritedToken, reentrant: true, release: async () => undefined };
    }
  }

  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  let announced = false;
  let handle;
  let ownedFile;

  const refuse = (holder, details) => new Error(
    `Another run owns this worktree: ${describe(holder, details)}. `
    + `Waited ${String(Math.round(waitMs / 1_000))}s. Only one build, test, coverage, watch, packaging or `
    + "validation run may own this worktree at a time.\n"
    + "A run releases this lock when its work finishes. Bachata never reclaims it automatically, because the "
    + "run it protects may have started compilers, test runners or other work that outlives the process "
    + "named above, and a dead wrapper is no proof that they stopped.\n"
    + "To recover after a crash or a signalled run, first confirm nothing from that run is still working in "
    + `this worktree. Then, ${holder
      ? `read the token from ${lockPath} and run\n  npm run worktree:unlock -- LOCK_TOKEN\nreplacing LOCK_TOKEN with that token.`
      : `because ${lockPath} holds no readable token to quote back, run\n  npm run worktree:unlock -- --unreadable`}`,
  );

  const backOff = async (holder, details) => {
    if (Date.now() >= deadline) throw refuse(holder, details);
    if (!announced) {
      announced = true;
      log(`Waiting for the Bachata worktree lock held by ${describe(holder, details)} before starting ${label}.`);
    }
    await sleep(Math.max(10, Math.min(pollMs, deadline - Date.now())));
  };

  const dropContestedAttempt = async () => {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    ownedFile = undefined;
  };

  // Removing this run's own published lock, under the fence and on the same identity proof
  // release uses. Nothing in this module ever reclaims a canonical lock, so a run that
  // published one and then gave up must take it back itself or block every later build, test
  // and coverage run in this worktree until an operator clears it.
  const removeOwnPublication = async () => {
    const fence = await acquireFence({
      lockPath,
      label: `releasing ${label}`,
      waitMs: RELEASE_FENCE_WAIT_MS,
      pollMs,
      hooks,
    });
    if (!fence) {
      log(
        "Could not take the Bachata worktree fence to release the lock. The lock file is left in place; "
        + "clear it with `npm run worktree:unlock -- LOCK_TOKEN`, replacing LOCK_TOKEN with the token in "
        + "that file, once nothing from this run is still working "
        + "in this worktree.",
      );
      await handle?.close().catch(() => undefined);
      handle = undefined;
      return;
    }
    try {
      await runHook(hooks, "beforeReleaseRemove");
      const holder = await readRecord(lockPath);
      const current = await readFileIdentity(lockPath);
      if (!identityMatches({ details: current, record: holder }, { details: ownedFile, token })) return;
      await removeFencedLock({
        lockPath,
        judged: ownedFile ?? current,
        judgedToken: token,
        fence,
        hooks,
      });
    } finally {
      await fence.release();
      await handle?.close().catch(() => undefined);
      handle = undefined;
    }
  };

  for (;;) {
    // Invariant 3, before: never create a lock while a delete is in flight.
    if (await fenceIsHeld(lockPath, hooks)) {
      await backOff(undefined, undefined);
      continue;
    }
    // The record is written and synced to a private claim first, and only a complete file
    // is linked into the canonical path. A crash or a failed write can therefore leave a
    // private claim for the sweep, but never an unreadable canonical lock that no operator
    // can identify.
    const claimPath = `${lockPath}${CLAIM_INFIX}${token}`;
    try {
      handle = await open(claimPath, "wx", 0o600);
      await handle.writeFile(recordText(token, label, heartbeatMs), "utf8");
      await handle.sync();
      await runHook(hooks, "beforePublish");
      await link(claimPath, lockPath);
      await rm(claimPath, { force: true }).catch(() => undefined);
      ownedFile = await readFileIdentity(lockPath);
      await runHook(hooks, "afterCreate");
    } catch (error) {
      await rm(claimPath, { force: true }).catch(() => undefined);
      await dropContestedAttempt();
      if (error?.code !== "EEXIST") throw error;
      const details = await regularFileDetails(lockPath, "lock");
      if (!details) continue;
      // Somebody else owns it. There is no branch here that takes it: ownership is never
      // transferred by this module, only released by its owner or removed by an operator
      // through recoverWorktreeLock.
      await backOff(await readRecord(lockPath), details);
      continue;
    }

    // Invariant 3, after: creating the file is not ownership. This run waits out any fence
    // that appeared while it was writing, and then confirms the canonical path is still its
    // own file. It removes nothing but that file, so it can never remove a lock another run
    // owns; anything that ends the attempt after publication takes that file back first.
    try {
      if (await fenceIsHeld(lockPath, hooks)) {
        await runHook(hooks, "afterContestedCreate");
        while (await fenceIsHeld(lockPath, hooks)) {
          if (Date.now() >= deadline) throw refuse(undefined, undefined);
          await sleep(Math.max(10, Math.min(pollMs, deadline - Date.now())));
        }
      }
      const survivor = await readFileIdentity(lockPath);
      const stillOurs = await readRecord(lockPath);
      if (identityMatches({ details: survivor, record: stillOurs }, { details: ownedFile, token })) break;
    } catch (error) {
      await removeOwnPublication();
      await dropContestedAttempt();
      throw error;
    }
    await dropContestedAttempt();
  }

  environment[WORKTREE_LOCK_OWNER_ENVIRONMENT] = token;

  // Diagnostic only, not a safety mechanism. Invariant 2 already makes displacement of a
  // living owner impossible, so this can only fire when a human removes or replaces the
  // file by hand; when it does, the release below removes nothing.
  let lost = false;
  const heartbeat = setInterval(() => {
    const now = new Date();
    void handle?.utimes(now, now).catch(() => undefined);
    void (async () => {
      if (lost || released) return;
      const current = await readFileIdentity(lockPath);
      const holder = await readRecord(lockPath);
      if (identityMatches({ details: current, record: holder }, { details: ownedFile, token })) return;
      lost = true;
      log(`This run no longer owns the Bachata worktree lock: ${lockPath} was replaced while ${label} was running.`);
    })();
  }, heartbeatMs);
  heartbeat.unref?.();

  let released = false;
  const forget = () => {
    if (environment[WORKTREE_LOCK_OWNER_ENVIRONMENT] === token) {
      delete environment[WORKTREE_LOCK_OWNER_ENVIRONMENT];
    }
  };

  // No signal handler and no exit-time deletion. A lock is released by the run that took
  // it, explicitly, once the work it protects has finished — see withWorktreeLock. Any
  // death that skips that release leaves the lock for an operator, because this process
  // cannot know whether the compilers, test runners and other descendants it started have
  // stopped. Releasing on a signal would hand the worktree on while they were still
  // writing to it.

  return {
    token,
    reentrant: false,
    // Diagnostic: false once the canonical path stopped being this run's file. Safety does
    // not rest on it — nothing takes a lock from a living process in the first place.
    ownsWorktree: async () => {
      if (released || lost) return false;
      const current = await readFileIdentity(lockPath);
      const holder = await readRecord(lockPath);
      return identityMatches({ details: current, record: holder }, { details: ownedFile, token });
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      forget();
      // Invariant 2: releasing deletes under the same fence a reclaim uses, so no reclaim
      // can be part-way through and no acquirer can have created a replacement here.
      await removeOwnPublication();
    },
  };
};

export const withWorktreeLock = async (options, operation) => {
  const lock = await acquireWorktreeLock(options);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
};

// Sweeping is safe by construction: every path it touches is already off the canonical
// lock path, so removing one can never make two runs owners.
export const sweepWorktreeLockResidue = async (lockPath = defaultWorktreeLockPath()) => {
  const directory = path.dirname(lockPath);
  const lockBase = path.basename(lockPath);
  const fenceBase = path.basename(fencePathFor(lockPath));
  const residuePrefixes = [
    // A lock or fence moved aside by a fenced removal.
    `${lockBase}${RETIRED_INFIX}`,
    `${fenceBase}${RETIRED_INFIX}`,
    // A private claim whose link never landed, for a lock or for a fence.
    `${lockBase}${CLAIM_INFIX}`,
    `${fenceBase}${CLAIM_INFIX}`,
  ];
  const entries = await readdir(directory, { withFileTypes: true }).catch(ignoreMissing);
  const removed = [];
  for (const entry of entries ?? []) {
    if (!entry.isFile()) continue;
    if (!residuePrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const candidate = path.join(directory, entry.name);
    const record = await readRecord(candidate);
    // A record that cannot be read may be a claim that is being written right now, so it
    // is never swept. Only a complete record naming a process proven gone is residue.
    if (!ownerIsProvablyDead(record)) continue;
    await rm(candidate, { force: true }).catch(() => undefined);
    removed.push(entry.name);
  }
  return removed;
};

/**
 * Explicit operator recovery, the only way a canonical lock this module did not create is
 * ever removed. It is never called automatically: the operator states which lock they mean
 * by passing the token printed in the file, having satisfied themselves that nothing the
 * dead run started is still working in this worktree.
 */
export const recoverWorktreeLock = async ({
  lockPath = defaultWorktreeLockPath(),
  expectedToken,
  confirmUnreadable = false,
  waitMs = 30_000,
  pollMs = DEFAULT_POLL_MS,
  hooks = NO_HOOKS,
  log = (message) => process.stdout.write(`${message}\n`),
} = {}) => {
  const record = await readRecord(lockPath);
  const present = await lstat(lockPath).catch(ignoreMissing);
  if (record === undefined && !present) return { removed: false, reason: "no lock is present" };

  // A lock whose record cannot be read has no token to quote back, so it needs its own
  // explicit confirmation. It is still never reclaimed on age, on a dead wrapper, or
  // automatically: the operator states that this lock is the one they mean.
  const unreadable = record === undefined;
  if (unreadable) {
    if (confirmUnreadable !== true) {
      return {
        removed: false,
        reason: "the lock record cannot be read, so recovery needs the unreadable-record confirmation",
      };
    }
  } else {
    if (typeof expectedToken !== "string" || expectedToken.length === 0) {
      return { removed: false, reason: "recovery requires the token recorded in the lock file" };
    }
    if (record.token !== expectedToken) {
      return { removed: false, reason: "the lock does not carry the token given, so it is a different lock" };
    }
  }

  const fence = await acquireFence({ lockPath, label: "operator recovery", waitMs, pollMs, hooks });
  if (!fence) return { removed: false, reason: "another run holds the fence" };
  try {
    await runHook(hooks, "afterRecoveryFence");
    const details = await regularFileDetails(lockPath, "lock");
    const current = await readRecord(lockPath);
    if (!details) {
      return { removed: false, reason: "the lock changed while recovery was starting" };
    }
    let judgedBytes;
    if (unreadable) {
      // Becoming readable under the fence means a different, live lock now holds the path.
      if (current !== undefined) {
        return { removed: false, reason: "the lock became readable while recovery was starting, so it is a different lock" };
      }
      if (!usableInode(details)) {
        return { removed: false, reason: "this filesystem reports no stable file identity, so an unreadable lock cannot be proven" };
      }
      judgedBytes = await readFile(lockPath, "utf8").catch(ignoreMissing);
      if (judgedBytes === undefined) {
        return { removed: false, reason: "the lock changed while recovery was starting" };
      }
    } else if (current?.token !== expectedToken) {
      return { removed: false, reason: "the lock changed while recovery was starting" };
    }
    const removed = await removeFencedLock({
      lockPath,
      judged: details,
      ...(unreadable ? { judgedBytes } : { judgedToken: expectedToken }),
      fence,
      hooks,
    });
    if (removed) log(`Removed the worktree lock recorded for ${describe(current, details)} at operator request.`);
    return { removed, reason: removed ? "removed at operator request" : "the lock changed during recovery" };
  } finally {
    await fence.release();
  }
};
