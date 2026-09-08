import { isUtf8 } from "node:buffer";

export type BoundedBuffer = {
  chunks: Buffer[];
  bytes: number;
  maximumBytes: number;
  truncated: boolean;
};

const utf8Prefix = (value: string, maximumBytes: number): string => {
  if (maximumBytes <= 0) {
    return "";
  }
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
};

export const truncateUtf8Text = (
  value: string,
  maximumBytes: number,
  marker = "\n[output truncated]",
): string => {
  const limit = Math.max(0, Math.floor(maximumBytes));
  if (Buffer.byteLength(value, "utf8") <= limit) {
    return value;
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= limit) {
    return utf8Prefix(value, limit);
  }
  return `${utf8Prefix(value, limit - markerBytes)}${marker}`;
};

export const createBoundedBuffer = (
  maximumBytes: number,
): BoundedBuffer => ({
  chunks: [],
  bytes: 0,
  maximumBytes: Math.max(0, Math.floor(maximumBytes)),
  truncated: false,
});

export const appendBoundedBuffer = (
  state: BoundedBuffer,
  addition: Buffer,
): void => {
  const remaining = state.maximumBytes - state.bytes;
  if (remaining <= 0) {
    if (addition.length > 0) {
      state.truncated = true;
    }
    return;
  }
  const retained = addition.subarray(0, remaining);
  if (retained.length > 0) {
    state.chunks.push(retained);
    state.bytes += retained.length;
  }
  if (retained.length < addition.length) {
    state.truncated = true;
  }
};

const decodeUtf8Buffer = (value: Buffer): string => {
  for (let removed = 0; removed <= Math.min(3, value.length); removed += 1) {
    const candidate = value.subarray(0, value.length - removed);
    if (isUtf8(candidate)) {
      return candidate.toString("utf8");
    }
  }
  return value.toString("utf8");
};

export const boundedBufferText = (
  state: BoundedBuffer,
  marker = "\n[output truncated]",
): string => {
  const decoded = decodeUtf8Buffer(Buffer.concat(state.chunks, state.bytes));
  if (!state.truncated) {
    return truncateUtf8Text(decoded, state.maximumBytes, marker);
  }
  if (Buffer.byteLength(marker, "utf8") >= state.maximumBytes) {
    return truncateUtf8Text(decoded, state.maximumBytes, "");
  }
  return truncateUtf8Text(
    `${decoded}${marker}`,
    state.maximumBytes,
    marker,
  );
};
