import {
  capturedAssetKeys,
  validCapturedAssetFields,
  type CapturedAsset,
} from "../browser/protocol";
import type { TranscriptEntry } from "../webview/protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A captured asset read back out of a persisted transcript.
 *
 * The transcript is the runtime's own record, but it survives restarts and lives on disk, so
 * every field is re-validated with `validCapturedAssetFields` — the same rules the wire
 * parser applies, including the canonical-origin and length limits that decide what the save
 * dialog may name.
 *
 * The one deliberate difference from the wire parser is unknown keys. A message from the
 * browser carrying a key the protocol does not declare is rejected outright; a stored record
 * carrying one was written by an older or newer build of Bachata itself, so it is read rather
 * than refused. The result is rebuilt from the declared keys alone, so nothing undeclared
 * reaches a caller either way.
 */
export const parseCapturedAsset = (value: unknown): CapturedAsset | undefined => {
  if (!validCapturedAssetFields(value)) {
    return undefined;
  }
  return {
    id: value.id,
    provider: value.provider,
    kind: value.kind,
    name: value.name,
    sourceElement: value.sourceElement,
    downloadAvailable: value.downloadAvailable,
    ...(value.mimeType === undefined ? {} : { mimeType: value.mimeType }),
    ...(value.size === undefined ? {} : { size: value.size }),
    ...(value.providerAssetId === undefined
      ? {}
      : { providerAssetId: value.providerAssetId }),
    ...(value.previewText === undefined ? {} : { previewText: value.previewText }),
    ...(value.sourceOrigin === undefined ? {} : { sourceOrigin: value.sourceOrigin }),
  };
};

/** The declared keys a parsed asset can carry, for callers asserting nothing else survives. */
export const parsedCapturedAssetKeys = capturedAssetKeys;

/**
 * The newest transcript record of an asset id.
 *
 * A response can be captured more than once for the same conversation, and the last record
 * is the one the user is looking at, so the search runs backwards and stops at the first
 * entry that still validates.
 */
export const findCapturedAsset = (
  entries: readonly TranscriptEntry[],
  assetId: string,
): CapturedAsset | undefined => {
  for (const entry of [...entries].reverse()) {
    if (
      entry.eventType !== "browser.response" ||
      !isRecord(entry.data) ||
      !Array.isArray(entry.data.assets)
    ) {
      continue;
    }
    const value = entry.data.assets.find(
      (item) => isRecord(item) && item.id === assetId,
    );
    const parsed = parseCapturedAsset(value);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
};
