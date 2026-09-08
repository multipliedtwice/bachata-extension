import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import * as path from "node:path";

import { TranscriptEntry, parseTranscriptEntry } from "../webview/protocol";

export type TranscriptPage = {
  entries: TranscriptEntry[];
  total: number;
  hasMore: boolean;
};

export type TranscriptStoreOptions = {
  maxEntries?: number;
  maxFileBytes?: number;
  maxTextBytes?: number;
  maxDataBytes?: number;
  withMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
};

export type TranscriptStore = {
  load: () => Promise<TranscriptEntry[]>;
  loadRecent: (limit: number) => Promise<TranscriptPage>;
  loadBefore: (beforeId: string | undefined, limit: number) => Promise<TranscriptPage>;
  append: (entry: TranscriptEntry) => Promise<void>;
  replace: (entries: TranscriptEntry[]) => Promise<void>;
  clear: () => Promise<void>;
  flush: () => Promise<void>;
  filePath: string;
};

type FileSignature = {
  size: number;
  modifiedAt: number;
};

type TranscriptMetadata = FileSignature & {
  version: 1;
  total: number;
};

type Offset = {
  start: number;
  end: number;
};

type ParsedLine = {
  entry: TranscriptEntry;
  offset: Offset;
};

const metadataVersion = 1;
const reverseChunkBytes = 64 * 1024;
const offsetCacheLimit = 10_000;
const defaultMaxEntries = 2_000;
const defaultMaxFileBytes = 2 * 1024 * 1024;
const defaultMaxTextBytes = 8 * 1024;
const defaultMaxDataBytes = 16 * 1024;
const truncatedTextSuffix = "\n\n[Local preview truncated. Open the provider chat for the full response.]";

const positiveInteger = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return value;
  }
  const suffixBytes = Buffer.byteLength(truncatedTextSuffix, "utf8");
  const bodyLimit = Math.max(0, maxBytes - suffixBytes);
  let end = Math.min(bodyLimit, bytes.length);
  while (end > 0) {
    const candidate = bytes.subarray(0, end).toString("utf8");
    if (!candidate.endsWith("\uFFFD")) {
      return `${candidate}${truncatedTextSuffix}`;
    }
    end -= 1;
  }
  return truncatedTextSuffix.slice(0, maxBytes);
};

const compactJsonValue = (value: TranscriptEntry["data"], maxBytes: number): TranscriptEntry["data"] => {
  if (value === undefined) {
    return undefined;
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return value;
  }
  return {
    truncated: true,
    preview: truncateUtf8(serialized, Math.max(256, maxBytes - 128)),
  };
};

const syncDirectory = async (directory: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const atomicWriteText = async (
  target: string,
  content: string,
): Promise<void> => {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseMetadata = (value: unknown): TranscriptMetadata | undefined => {
  if (
    !isRecord(value) ||
    value.version !== metadataVersion ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.modifiedAt !== "number" ||
    !Number.isFinite(value.modifiedAt) ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0
  ) {
    return undefined;
  }
  return {
    version: metadataVersion,
    size: value.size,
    modifiedAt: value.modifiedAt,
    total: value.total,
  };
};

export const createTranscriptStore = (
  storageDirectory: string,
  log: (message: string) => void,
  options: TranscriptStoreOptions = {},
): TranscriptStore => {
  const maxEntries = positiveInteger(options.maxEntries, defaultMaxEntries);
  const maxFileBytes = positiveInteger(options.maxFileBytes, defaultMaxFileBytes);
  const maxTextBytes = positiveInteger(options.maxTextBytes, defaultMaxTextBytes);
  const maxDataBytes = positiveInteger(options.maxDataBytes, defaultMaxDataBytes);
  const withMutation = options.withMutation ?? (async <T>(operation: () => Promise<T>): Promise<T> => operation());
  const filePath = path.join(storageDirectory, "transcript.jsonl");
  const metadataPath = path.join(storageDirectory, "transcript.index.json");
  let queue = Promise.resolve();
  let metadata: TranscriptMetadata | undefined;
  const offsets = new Map<string, Offset>();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const ensureDirectory = async (): Promise<void> => {
    await mkdir(storageDirectory, { recursive: true });
  };

  const fileSignature = async (): Promise<FileSignature | undefined> => {
    try {
      const value = await stat(filePath);
      return { size: value.size, modifiedAt: value.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  const cacheOffset = (entryId: string, offset: Offset): void => {
    offsets.delete(entryId);
    offsets.set(entryId, offset);
    while (offsets.size > offsetCacheLimit) {
      const oldest = offsets.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      offsets.delete(oldest);
    }
  };

  const parseLine = (
    bytes: Buffer,
    lineNumber: number | undefined,
    offset: Offset,
  ): ParsedLine | undefined => {
    const text = bytes.toString("utf8").replace(/\r$/, "");
    if (!text.trim()) {
      return undefined;
    }
    try {
      const entry = parseTranscriptEntry(JSON.parse(text));
      if (!entry) {
        log(
          lineNumber === undefined
            ? `Ignored invalid transcript entry at byte ${String(offset.start)}`
            : `Ignored invalid transcript line ${String(lineNumber)}`,
        );
        return undefined;
      }
      cacheOffset(entry.id, offset);
      return { entry, offset };
    } catch (error) {
      log(
        `${lineNumber === undefined ? `Ignored malformed transcript entry at byte ${String(offset.start)}` : `Ignored malformed transcript line ${String(lineNumber)}`}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  const writeMetadata = async (value: TranscriptMetadata): Promise<void> => {
    await ensureDirectory();
    await atomicWriteText(metadataPath, JSON.stringify(value));
    metadata = value;
  };

  const compactEntry = (entry: TranscriptEntry): TranscriptEntry => {
    const data = compactJsonValue(entry.data, maxDataBytes);
    return {
      ...entry,
      text: truncateUtf8(entry.text, maxTextBytes),
      ...(data === undefined ? {} : { data }),
    };
  };

  const writeEntries = async (entries: TranscriptEntry[]): Promise<void> => {
    await ensureDirectory();
    const compacted = entries.map(compactEntry);
    const content = compacted.map((entry) => JSON.stringify(entry)).join("\n");
    await atomicWriteText(filePath, content ? `${content}\n` : "");
    offsets.clear();
    const signature = await fileSignature();
    await writeMetadata({
      version: metadataVersion,
      size: signature?.size ?? 0,
      modifiedAt: signature?.modifiedAt ?? 0,
      total: compacted.length,
    });
  };

  const enforceLimits = async (): Promise<void> => {
    const current = await ensureMetadata();
    if (current.total <= maxEntries && current.size <= maxFileBytes) {
      return;
    }
    const scanned = await scanForward(0, current.size, true);
    let retained = scanned.entries.slice(-maxEntries).map(compactEntry);
    while (retained.length > 1) {
      const bytes = Buffer.byteLength(
        `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );
      if (bytes <= maxFileBytes) {
        break;
      }
      retained = retained.slice(1);
    }
    await writeEntries(retained);
  };

  const readMetadata = async (): Promise<TranscriptMetadata | undefined> => {
    if (metadata) {
      return metadata;
    }
    try {
      metadata = parseMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
      return metadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log(
          `Ignored invalid transcript index: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return undefined;
    }
  };

  const scanForward = async (
    start: number,
    end: number,
    collect: boolean,
  ): Promise<{ entries: TranscriptEntry[]; total: number }> => {
    if (end <= start) {
      return { entries: [], total: 0 };
    }
    const handle = await open(filePath, "r");
    const entries: TranscriptEntry[] = [];
    let total = 0;
    let position = start;
    let pending = Buffer.alloc(0);
    let pendingStart = start;
    let lineNumber = 0;
    try {
      while (position < end) {
        const length = Math.min(reverseChunkBytes, end - position);
        const chunk = Buffer.alloc(length);
        const result = await handle.read(chunk, 0, length, position);
        if (result.bytesRead <= 0) {
          break;
        }
        const data = Buffer.concat([pending, chunk.subarray(0, result.bytesRead)]);
        let lineStart = 0;
        for (let index = 0; index < data.length; index += 1) {
          if (data[index] !== 0x0a) {
            continue;
          }
          lineNumber += 1;
          const absoluteStart = pendingStart + lineStart;
          const absoluteEnd = pendingStart + index;
          const parsed = parseLine(
            data.subarray(lineStart, index),
            lineNumber,
            { start: absoluteStart, end: absoluteEnd },
          );
          if (parsed) {
            total += 1;
            if (collect) {
              entries.push(parsed.entry);
            }
          }
          lineStart = index + 1;
        }
        pending = data.subarray(lineStart);
        pendingStart += lineStart;
        position += result.bytesRead;
      }
      if (pending.length > 0) {
        lineNumber += 1;
        const parsed = parseLine(pending, lineNumber, {
          start: pendingStart,
          end,
        });
        if (parsed) {
          total += 1;
          if (collect) {
            entries.push(parsed.entry);
          }
        }
      }
      return { entries, total };
    } finally {
      await handle.close();
    }
  };

  const rebuildMetadata = async (
    signature: FileSignature,
  ): Promise<TranscriptMetadata> => {
    offsets.clear();
    const scan = await scanForward(0, signature.size, false);
    const next: TranscriptMetadata = {
      version: metadataVersion,
      size: signature.size,
      modifiedAt: signature.modifiedAt,
      total: scan.total,
    };
    await writeMetadata(next);
    return next;
  };

  const ensureMetadata = async (): Promise<TranscriptMetadata> => {
    const signature = await fileSignature();
    if (!signature) {
      const empty: TranscriptMetadata = {
        version: metadataVersion,
        size: 0,
        modifiedAt: 0,
        total: 0,
      };
      metadata = empty;
      return empty;
    }
    const current = await readMetadata();
    if (
      current &&
      current.size === signature.size &&
      current.modifiedAt === signature.modifiedAt
    ) {
      return current;
    }
    if (current && current.size < signature.size) {
      const appended = await scanForward(current.size, signature.size, false);
      const next: TranscriptMetadata = {
        version: metadataVersion,
        size: signature.size,
        modifiedAt: signature.modifiedAt,
        total: current.total + appended.total,
      };
      await writeMetadata(next);
      return next;
    }
    return rebuildMetadata(signature);
  };

  const reversePage = async (
    endOffset: number,
    limit: number,
  ): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> => {
    const handle = await open(filePath, "r");
    const wanted = Math.max(1, Math.floor(limit));
    const reversed: TranscriptEntry[] = [];
    let position = endOffset;
    let suffix = Buffer.alloc(0);
    let suffixEnd = endOffset;

    const consumeLine = (bytes: Buffer, offset: Offset): boolean => {
      const parsed = parseLine(bytes, undefined, offset);
      if (!parsed) {
        return false;
      }
      reversed.push(parsed.entry);
      return reversed.length > wanted;
    };

    try {
      while (position > 0 && reversed.length <= wanted) {
        const start = Math.max(0, position - reverseChunkBytes);
        const length = position - start;
        const chunk = Buffer.alloc(length);
        const result = await handle.read(chunk, 0, length, start);
        if (result.bytesRead <= 0) {
          break;
        }
        const data = Buffer.concat([
          chunk.subarray(0, result.bytesRead),
          suffix,
        ]);
        const dataEnd = suffixEnd;
        let lineEnd = data.length;
        for (let index = data.length - 1; index >= 0; index -= 1) {
          if (data[index] !== 0x0a) {
            continue;
          }
          if (lineEnd > index + 1) {
            const absoluteEnd = dataEnd - (data.length - lineEnd);
            const absoluteStart = dataEnd - (data.length - (index + 1));
            if (
              consumeLine(data.subarray(index + 1, lineEnd), {
                start: absoluteStart,
                end: absoluteEnd,
              })
            ) {
              break;
            }
          }
          lineEnd = index;
        }
        suffix = data.subarray(0, lineEnd);
        suffixEnd = dataEnd - (data.length - lineEnd);
        position = start;
      }
      if (position === 0 && suffix.length > 0 && reversed.length <= wanted) {
        consumeLine(suffix, { start: 0, end: suffixEnd });
      }
      const hasMore = reversed.length > wanted;
      return {
        entries: reversed.slice(0, wanted).reverse(),
        hasMore,
      };
    } finally {
      await handle.close();
    }
  };

  const findOffset = async (entryId: string, size: number): Promise<Offset> => {
    const cached = offsets.get(entryId);
    if (cached && cached.end <= size) {
      return cached;
    }
    const handle = await open(filePath, "r");
    let position = size;
    let suffix = Buffer.alloc(0);
    let suffixEnd = size;
    try {
      while (position > 0) {
        const start = Math.max(0, position - reverseChunkBytes);
        const length = position - start;
        const chunk = Buffer.alloc(length);
        const result = await handle.read(chunk, 0, length, start);
        if (result.bytesRead <= 0) {
          break;
        }
        const data = Buffer.concat([
          chunk.subarray(0, result.bytesRead),
          suffix,
        ]);
        const dataEnd = suffixEnd;
        let lineEnd = data.length;
        for (let index = data.length - 1; index >= 0; index -= 1) {
          if (data[index] !== 0x0a) {
            continue;
          }
          if (lineEnd > index + 1) {
            const absoluteEnd = dataEnd - (data.length - lineEnd);
            const absoluteStart = dataEnd - (data.length - (index + 1));
            const parsed = parseLine(data.subarray(index + 1, lineEnd), undefined, {
              start: absoluteStart,
              end: absoluteEnd,
            });
            if (parsed?.entry.id === entryId) {
              return parsed.offset;
            }
          }
          lineEnd = index;
        }
        suffix = data.subarray(0, lineEnd);
        suffixEnd = dataEnd - (data.length - lineEnd);
        position = start;
      }
      if (suffix.length > 0) {
        const parsed = parseLine(suffix, undefined, { start: 0, end: suffixEnd });
        if (parsed?.entry.id === entryId) {
          return parsed.offset;
        }
      }
    } finally {
      await handle.close();
    }
    throw new Error(`Transcript entry ${entryId} was not found`);
  };

  const load = (): Promise<TranscriptEntry[]> =>
    enqueue(() => withMutation(async () => {
      const value = await ensureMetadata();
      if (value.size === 0) {
        return [];
      }
      return (await scanForward(0, value.size, true)).entries;
    }));

  const loadRecent = (limit: number): Promise<TranscriptPage> =>
    enqueue(() => withMutation(async () => {
      const value = await ensureMetadata();
      if (value.size === 0) {
        return { entries: [], total: 0, hasMore: false };
      }
      const page = await reversePage(value.size, limit);
      return { ...page, total: value.total };
    }));

  const loadBefore = (
    beforeId: string | undefined,
    limit: number,
  ): Promise<TranscriptPage> =>
    enqueue(() => withMutation(async () => {
      const value = await ensureMetadata();
      if (value.size === 0) {
        if (beforeId) {
          throw new Error(`Transcript entry ${beforeId} was not found`);
        }
        return { entries: [], total: 0, hasMore: false };
      }
      const end = beforeId
        ? (await findOffset(beforeId, value.size)).start
        : value.size;
      const page = await reversePage(end, limit);
      return { ...page, total: value.total };
    }));

  const append = (entry: TranscriptEntry): Promise<void> =>
    enqueue(() => withMutation(async () => {
      await ensureDirectory();
      const current = await ensureMetadata();
      const compacted = compactEntry(entry);
      const serialized = `${JSON.stringify(compacted)}\n`;
      await appendFile(filePath, serialized, "utf8");
      const signature = await fileSignature();
      if (!signature) {
        throw new Error("Transcript append did not create the transcript file");
      }
      const serializedBytes = Buffer.byteLength(serialized, "utf8");
      if (signature.size === current.size + serializedBytes) {
        cacheOffset(compacted.id, {
          start: current.size,
          end: signature.size - 1,
        });
        await writeMetadata({
          version: metadataVersion,
          size: signature.size,
          modifiedAt: signature.modifiedAt,
          total: current.total + 1,
        });
      } else {
        await rebuildMetadata(signature);
      }
      await enforceLimits();
    }));

  const replace = (entries: TranscriptEntry[]): Promise<void> =>
    enqueue(() => withMutation(async () => {
      await writeEntries(entries.slice(-maxEntries));
      await enforceLimits();
    }));

  const clear = (): Promise<void> =>
    enqueue(() => withMutation(async () => {
      await Promise.all([
        rm(filePath, { force: true }),
        rm(metadataPath, { force: true }),
      ]);
      offsets.clear();
      metadata = {
        version: metadataVersion,
        size: 0,
        modifiedAt: 0,
        total: 0,
      };
    }));

  return {
    load,
    loadRecent,
    loadBefore,
    append,
    replace,
    clear,
    flush: async () => {
      await queue;
    },
    filePath,
  };
};
