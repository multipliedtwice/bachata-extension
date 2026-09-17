import type { Stats } from "node:fs";

/**
 * Whether two stat results name the same file.
 *
 * On POSIX the pair `dev`/`ino` is the identity, and a guard that compares them catches a path
 * swapped for another file between two calls. Windows does not always supply one: `fs.Stats.ino`
 * carries the file index where the filesystem exposes it and `0` where it does not, and neither
 * `O_NOFOLLOW` nor `O_DIRECTORY` exists there, so a descriptor's stat can legitimately disagree
 * with the stat of the path it was opened from.
 *
 * Reading an absent inode as "a different file" refused every directory the extension validated on
 * Windows. So `0` means the identity is unavailable, not that the files differ, and the caller is
 * left with the type and size comparisons it already makes. That is weaker than inode fencing, and
 * it is what the platform affords; `usableFileIdentity` lets a caller say so in its own message
 * rather than silently believing it checked something it did not.
 */
export const usableFileIdentity = (value: Stats): boolean =>
  Number.isFinite(Number(value.ino)) && Number(value.ino) > 0;

/**
 * Whether both stats carry a device number worth comparing.
 *
 * Windows answers `lstat` on a path with `dev` 0 while `fstat` on a handle to that same file
 * reports the real volume, so comparing the pair reported one file as two and refused every
 * directory validated through a handle. An absent device is unknown, not different; the file
 * index still decides, and it is the stronger half of the pair.
 */
const comparableDevice = (left: Stats, right: Stats): boolean =>
  Number(left.dev) > 0 && Number(right.dev) > 0;

export const sameFileIdentity = (left: Stats, right: Stats): boolean =>
  usableFileIdentity(left) && usableFileIdentity(right)
    ? left.ino === right.ino && (!comparableDevice(left, right) || left.dev === right.dev)
    : true;

/**
 * The observed identity, for an error a human has to act on. A refusal that names only the path
 * cannot be told apart from a refusal caused by the inode being unavailable, which is the failure
 * mode this file exists to describe.
 */
export const describeFileIdentity = (value: Stats): string =>
  usableFileIdentity(value) ? `dev ${String(value.dev)} inode ${String(value.ino)}` : "no inode";
