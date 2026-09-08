import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";

const tracked = new Set();

export const trackedTemporaryDirectories = () => [...tracked];

export const createTrackedTemporaryDirectory = async (prefix) => {
  const directory = await mkdtemp(prefix);
  tracked.add(directory);
  return directory;
};

export const removeTrackedTemporaryDirectory = (directory) => {
  try {
    rmSync(directory, { recursive: true, force: true });
    tracked.delete(directory);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

export const removeEveryTrackedTemporaryDirectory = () => {
  const failures = [];
  for (const directory of [...tracked]) {
    const first = removeTrackedTemporaryDirectory(directory);
    if (first === undefined) continue;
    const second = removeTrackedTemporaryDirectory(directory);
    if (second !== undefined) failures.push(`${directory}: ${second}`);
  }
  return failures;
};
