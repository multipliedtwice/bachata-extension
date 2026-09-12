import type { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { fromBuffer, type Entry } from "yauzl";

export const deliverableLimits = {
  assets: 8,
  entries: 4096,
  compressedBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024,
  patchBytes: 8 * 1024 * 1024,
  changedFiles: 512,
  pathCharacters: 512,
  timeoutMs: 60_000,
} as const;

export type DeliverableFile = { path: string; data: Buffer };

export const deliverablePath = (value: string): string => {
  if (!value || value.length > deliverableLimits.pathCharacters || /[\\:\x00-\x1f\x7f]/u.test(value)) {
    throw new Error("Deliverable contains an invalid or oversized relative path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error("Deliverable contains an unsafe relative path");
  }
  return value;
};

export const readDeliverableZip = (data: Buffer, signal: AbortSignal): Promise<DeliverableFile[]> => {
  signal.throwIfAborted();
  if (data.length > deliverableLimits.compressedBytes) throw new Error("Deliverable exceeds the download limit");
  return new Promise((resolve, reject) => {
    fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) { reject(new Error("Deliverable ZIP could not be opened")); return; }
      let finished = false;
      let activeStream: Readable | undefined;
      let entries = 0;
      let total = 0;
      const paths = new Set<string>();
      const files: DeliverableFile[] = [];
      const finish = (failure?: Error): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        activeStream?.destroy(failure);
        zip.close();
        if (failure) reject(failure); else resolve(files);
      };
      const abort = (): void => finish(new Error("Deliverable inspection interrupted"));
      const timeout = setTimeout(() => finish(new Error("Deliverable inspection timed out")), deliverableLimits.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      zip.on("error", () => finish(new Error("Deliverable ZIP is corrupt")));
      zip.on("end", () => finish());
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          signal.throwIfAborted();
          if (finished) return;
          if (++entries > deliverableLimits.entries) throw new Error("Deliverable has too many archive entries");
          const directory = entry.fileName.endsWith("/");
          const relative = deliverablePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
          const key = relative.normalize("NFC").toLowerCase();
          if (paths.has(key)) throw new Error("Deliverable contains duplicate or case-colliding paths");
          paths.add(key);
          const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
          if ((kind !== 0 && kind !== 0o100000 && kind !== 0o040000) || (kind === 0o040000 && !directory)) {
            throw new Error("Deliverable contains a link or special file");
          }
          if ((entry.generalPurposeBitFlag & 1) !== 0 || ![0, 8].includes(entry.compressionMethod)) {
            throw new Error("Encrypted or unsupported ZIP entries cannot be imported");
          }
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
            || entry.uncompressedSize > deliverableLimits.fileBytes
            || total + entry.uncompressedSize > deliverableLimits.expandedBytes) {
            throw new Error("Deliverable exceeds the expanded size limit");
          }
          total += entry.uncompressedSize;
          if (directory) {
            if (entry.uncompressedSize !== 0) throw new Error("Deliverable directory contains unexpected data");
            zip.readEntry();
            return;
          }
          const content = await new Promise<Buffer>((accept, fail) => {
            zip.openReadStream(entry, (streamError, stream) => {
              if (streamError) { fail(new Error("Deliverable ZIP entry could not be read")); return; }
              if (finished) { stream.destroy(); fail(new Error("Deliverable inspection ended")); return; }
              activeStream = stream;
              const chunks: Buffer[] = [];
              let size = 0;
              const stop = (): void => { stream.destroy(new Error("Deliverable inspection interrupted")); };
              signal.addEventListener("abort", stop, { once: true });
              stream.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (finished || signal.aborted || size > entry.uncompressedSize || size > deliverableLimits.fileBytes) {
                  stream.destroy(new Error("Deliverable ZIP entry exceeds its declared size"));
                } else chunks.push(chunk);
              });
              stream.once("error", fail);
              stream.once("close", () => { signal.removeEventListener("abort", stop); if (activeStream === stream) activeStream = undefined; });
              stream.once("end", () => {
                const value = Buffer.concat(chunks, size);
                if (size !== entry.uncompressedSize || crc32(value) !== entry.crc32) {
                  fail(new Error("Deliverable ZIP entry failed integrity validation"));
                } else accept(value);
              });
              if (signal.aborted) stop();
            });
          });
          if (finished) return;
          files.push({ path: relative, data: content });
          zip.readEntry();
        })().catch((failure: unknown) => finish(failure instanceof Error ? failure : new Error("Deliverable ZIP validation failed")));
      });
      if (signal.aborted) { abort(); return; }
      if (zip.entryCount > deliverableLimits.entries) { finish(new Error("Deliverable has too many archive entries")); return; }
      zip.readEntry();
    });
  });
};
