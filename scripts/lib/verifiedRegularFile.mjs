import { constants, lstat, open, realpath } from "node:fs/promises";
import * as path from "node:path";

const regularFile = (file, details) => {
  if (details.isSymbolicLink()) throw new Error(`${file} is a symbolic link; a regular file is required`);
  if (!details.isFile()) throw new Error(`${file} is not a regular file`);
};

// A missing Windows path volume is anchored outside mutable parent directories, never ignored.
const rootDevice = async (canonical) => {
  const handle = await open(path.parse(canonical).root, constants.O_RDONLY);
  try {
    const details = await handle.stat({ bigint: true });
    if (!details.isDirectory() || details.dev <= 0n) {
      throw new Error(`Cannot establish the filesystem volume for ${canonical}`);
    }
    return details.dev;
  } finally {
    await handle.close();
  }
};

export const openVerifiedRegularFile = async (file) => {
  const before = await lstat(file, { bigint: true });
  regularFile(file, before);
  const canonical = await realpath(file);
  const volume = process.platform === "win32" && before.dev === 0n
    ? await rootDevice(canonical) : undefined;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch((error) => {
    if (["ELOOP", "EMLINK", "ENOTDIR"].includes(error?.code)) {
      throw new Error(`${file} is a symbolic link; a regular file is required`);
    }
    throw error;
  });
  try {
    const details = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    regularFile(file, current);
    if (!details.isFile()) throw new Error(`${file} is not a regular file`);
    const sameVolume = process.platform !== "win32" ? before.dev === details.dev
      : before.dev === 0n ? volume > 0n && before.ino > 0n && details.dev === volume
        : (before.dev & 0xffff_ffffn) === (details.dev & 0xffff_ffffn);
    if (before.dev !== current.dev || before.ino !== current.ino || before.ino !== details.ino
      || !sameVolume || await realpath(file) !== canonical) {
      throw new Error(`${file} changed while it was being opened`);
    }
    return { handle, details };
  } catch (error) {
    await handle.close();
    throw error;
  }
};
