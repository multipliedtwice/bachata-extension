import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { sameFileIdentity } from "../process/fileIdentity";

export const sha256FilePath = async (
  absolutePath: string,
  signal?: AbortSignal,
): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("File hashing interrupted"));
      return;
    }
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    let settled = false;
    const abort = (): void => {
      stream.destroy(new Error("File hashing interrupted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    stream.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(hash.digest("hex"));
    });
  });

export const sha256EvidenceCopy = async (absolutePath: string): Promise<string> => {
  const named = await lstat(absolutePath);
  if (!named.isFile()) throw new Error("Evidence copies must be regular local files of at most 4 MiB");
  const file = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    const limit = 4 * 1024 * 1024;
    if (!sameFileIdentity(before, named)) throw new Error("Evidence copy changed during inspection");
    if (!before.isFile() || before.size > limit) throw new Error("Evidence copies must be regular local files of at most 4 MiB");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65_536);
    let size = 0;
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("Evidence copy inspection timed out");
      const next = await file.read(buffer, 0, buffer.length, size);
      if (next.bytesRead === 0) break;
      size += next.bytesRead;
      if (size > before.size || size > limit) throw new Error("Evidence copy changed during inspection");
      hash.update(buffer.subarray(0, next.bytesRead));
    }
    const after = await file.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Evidence copy changed during inspection");
    }
    return hash.digest("hex");
  } finally { await file.close(); }
};
