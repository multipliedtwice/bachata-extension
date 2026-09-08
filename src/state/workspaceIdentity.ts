import { realpathSync } from "node:fs";
import * as path from "node:path";

const canonicalizeMissingPath = (value: string): string => {
  const tail: string[] = [];
  let candidate = value;
  while (true) {
    try {
      return path.join(realpathSync.native(candidate), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      tail.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
};

export const canonicalWorkspaceStateIdentity = (storageRoot: string): string => {
  const canonical = canonicalizeMissingPath(path.resolve(storageRoot));
  return `storage:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
};
