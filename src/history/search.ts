export type HistoryScanResult = {
  matched: boolean;
  used: number;
  truncated: boolean;
};

type ScanSink = {
  needle: string;
  limit: number;
  used: number;
  matched: boolean;
  truncated: boolean;
};

const maximumDepth = 12;

const exhausted = (sink: ScanSink): boolean => sink.matched || sink.used >= sink.limit;

const codePointBytes = (codePoint: number): number => {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
};

export const boundedUtf8Prefix = (
  text: string,
  maxBytes: number,
): { chunk: string; bytes: number; truncated: boolean } => {
  if (maxBytes <= 0) return { chunk: "", bytes: 0, truncated: text.length > 0 };
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = codePointBytes(character.codePointAt(0) ?? 0);
    if (bytes + size > maxBytes) {
      return { chunk: text.slice(0, end), bytes, truncated: true };
    }
    bytes += size;
    end += character.length;
  }
  return { chunk: text, bytes, truncated: false };
};

// A hit has to sit inside one value. Carrying a tail across siblings made a query match when
// its halves landed in two unrelated fields, listing a run that contains the query nowhere.
const push = (sink: ScanSink, text: string): void => {
  if (exhausted(sink) || text.length === 0) return;
  const prefix = boundedUtf8Prefix(text, sink.limit - sink.used);
  if (prefix.truncated) sink.truncated = true;
  sink.used += prefix.bytes;
  if (prefix.chunk.toLocaleLowerCase().includes(sink.needle)) sink.matched = true;
};

const walk = (value: unknown, sink: ScanSink, seen: Set<object>, depth: number): void => {
  if (exhausted(sink) || value === null || value === undefined) return;
  if (typeof value === "string") {
    push(sink, value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    push(sink, String(value));
    return;
  }
  if (typeof value !== "object") return;
  if (depth >= maximumDepth || seen.has(value)) {
    sink.truncated = true;
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, sink, seen, depth + 1);
      if (exhausted(sink)) break;
    }
    seen.delete(value);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    push(sink, key);
    if (exhausted(sink)) break;
    walk(item, sink, seen, depth + 1);
    if (exhausted(sink)) break;
  }
  seen.delete(value);
};

export const historyScan = (
  query: string,
  values: unknown[],
  maxBytes = 2_097_152,
): HistoryScanResult => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { matched: true, used: 0, truncated: false };
  const sink: ScanSink = {
    needle,
    limit: Math.max(0, maxBytes),
    used: 0,
    matched: false,
    truncated: false,
  };
  const seen = new Set<object>();
  for (const value of values) {
    walk(value, sink, seen, 0);
    if (sink.matched) break;
    if (sink.used >= sink.limit) {
      sink.truncated = true;
      break;
    }
  }
  return { matched: sink.matched, used: sink.used, truncated: sink.truncated };
};

export const historyMatches = (
  query: string,
  values: unknown[],
  maxBytes = 2_097_152,
): boolean => historyScan(query, values, maxBytes).matched;
