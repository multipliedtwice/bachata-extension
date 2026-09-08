import { StringDecoder } from "node:string_decoder";

/*
 * Bounded stream decoding shared by the Claude and Codex adapters.
 *
 * Both adapters read newline-delimited JSON from a child process and text from its stderr.
 * `readline.createInterface` has no line-length limit, so a child that emits a very long
 * record with no newline — a stuck stream, a binary blob, a runaway log line — buffers it
 * whole inside the extension host with nothing to stop it. And decoding each stderr chunk
 * with `chunk.toString("utf8")` splits any multi-byte character that happens to land on a
 * chunk boundary, replacing it with U+FFFD in the retained diagnostic.
 *
 * Both are fixed here rather than in each adapter, because the two adapters had the same two
 * bugs and would otherwise drift apart while fixing them.
 */

export const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

export type BoundedLineDecoder = {
  /** Feed one chunk. Returns the complete lines it produced, in order. */
  push: (chunk: Buffer) => string[];
  /** Flush any final line that arrived without a trailing newline. */
  end: () => string[];
};

export class RecordTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`A single stream record exceeded the ${String(limit)} byte limit without a newline`);
    this.name = "RecordTooLargeError";
    this.limit = limit;
  }
}

/**
 * Splits a byte stream into newline-delimited records, decoding UTF-8 incrementally so a
 * character split across two chunks is still decoded once, correctly. A record that grows
 * past `maxRecordBytes` without a newline throws instead of buffering without limit: the
 * stream is already unusable at that point, and failing names why.
 */
export const createBoundedLineDecoder = (
  maxRecordBytes: number = DEFAULT_MAX_RECORD_BYTES,
): BoundedLineDecoder => {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  const take = (text: string): string[] => {
    pending += text;
    if (pending.length === 0) return [];
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    if (Buffer.byteLength(pending, "utf8") > maxRecordBytes) {
      pending = "";
      throw new RecordTooLargeError(maxRecordBytes);
    }
    return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  };

  return {
    push: (chunk) => take(decoder.write(chunk)),
    end: () => {
      const tail = take(decoder.end());
      const last = pending;
      pending = "";
      return last.length > 0 ? [...tail, last.endsWith("\r") ? last.slice(0, -1) : last] : tail;
    },
  };
};

export type IncrementalTextDecoder = {
  /** Decode one chunk, holding back any incomplete trailing character. */
  push: (chunk: Buffer) => string;
  /** Flush whatever remains, replacing a truncated final character. */
  end: () => string;
};

/**
 * Decodes a byte stream to text incrementally. A multi-byte character split across two
 * chunks is held until it is complete, so it is never reported as a replacement character.
 */
export const createIncrementalTextDecoder = (): IncrementalTextDecoder => {
  const decoder = new StringDecoder("utf8");
  return {
    push: (chunk) => decoder.write(chunk),
    end: () => decoder.end(),
  };
};

/**
 * Appends to a retained diagnostic buffer, keeping the most recent `limit` characters. The
 * tail is what explains a failure; the head is what a runaway process produces most of.
 */
export const appendBoundedText = (current: string, addition: string, limit: number): string => {
  const combined = current + addition;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
};
