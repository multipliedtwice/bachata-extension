import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

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
