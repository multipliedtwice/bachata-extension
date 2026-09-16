import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import * as path from "node:path";
import { isBrowserSourcePath } from "./sourceTransferPolicy";
import { isRestrictedWorkspacePath } from "./mutationPolicy";
import { sameFileIdentity } from "../process/fileIdentity";

export const captureSourceBaseline = async (workspaceRoot: string, signal: AbortSignal): Promise<Array<{ path: string; fingerprint: string }>> => {
  const root = await realpath(workspaceRoot);
  const entries: Array<{ path: string; fingerprint: string }> = [];
  const queue = [""];
  let count = 0;
  let totalBytes = 0;
  const deadline = Date.now() + 30_000;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const relativeDirectory = queue[cursor]!;
    const directoryPath = path.join(root, relativeDirectory);
    if (await realpath(directoryPath) !== directoryPath) throw new Error("Source baseline directory changed during inspection");
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (++count > 10_000 || Date.now() > deadline) throw new Error("Source baseline exceeds its inspection budget");
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relative.length > 512 || relative.split("/").length > 32) throw new Error("Source baseline path exceeds its inspection budget");
      if (!isBrowserSourcePath(relative) || isRestrictedWorkspacePath(relative)) continue;
      const absolute = path.join(root, relative);
      const before = await lstat(absolute);
      if (before.isSymbolicLink()) {
        entries.push({ path: relative, fingerprint: `symlink:${createHash("sha256").update(await readlink(absolute)).digest("hex")}` });
        continue;
      }
      if (before.isDirectory()) { queue.push(relative); continue; }
      if (!before.isFile() || before.size > 8 * 1024 * 1024 || totalBytes + before.size > 128 * 1024 * 1024) {
        throw new Error("Source baseline contains an unsupported or oversized file");
      }
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (await realpath(absolute) !== absolute) throw new Error("Source baseline file moved outside its directory");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(65536);
        let size = 0;
        for (;;) {
          signal.throwIfAborted();
          if (Date.now() > deadline) throw new Error("Source baseline inspection timed out");
          const read = await file.read(buffer, 0, buffer.length, size);
          if (!read.bytesRead) break;
          size += read.bytesRead;
          if (size > before.size) throw new Error("Source baseline file grew during inspection");
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await file.stat();
        if (size !== before.size || !sameFileIdentity(after, before) || after.mtimeMs !== before.mtimeMs) {
          throw new Error("Source baseline changed during inspection");
        }
        totalBytes += size;
        entries.push({ path: relative, fingerprint: `file:${String(before.mode)}:${hash.digest("hex")}` });
      } finally { await file.close(); }
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};
