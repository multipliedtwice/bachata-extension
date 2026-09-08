import { basename } from "node:path";

/*
 * Lifted out of createRuntime as one slice of EX-3.
 *
 * This closes over nothing: it is a pure string transform that decides the filename a browser
 * asset is offered under. Inside an 8,800-line factory it was reachable from a test only
 * through the whole runtime; at module scope its edge cases can be stated directly.
 *
 * The name is attacker-influenced — a model chooses it — so the transform strips directory
 * components, path separators, control characters and leading dots, and always yields a
 * non-empty name.
 *
 * The rules below are shared with the Browser Bridge, which sanitises the same names before
 * they are ever offered. `protocol/asset-name.fixtures.json` holds one table both repositories
 * assert against, and each pins its digest, so a rule cannot be changed on one side alone.
 */

// Bidirectional formatting characters reorder how a name is displayed without changing what
// it is, so a name carrying U+202E renders as though it ended `.png` and a human
// approving the save sees an extension the file does not have. They are removed rather than
// replaced, because substituting would leave a visible artefact in an ordinary name.
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

// Windows resolves these stems as devices whatever directory is named and whatever extension
// follows, so `CON.txt` is not a file. The name is kept and prefixed rather than refused,
// because dropping it would silently lose an asset the user asked to save.
const WINDOWS_DEVICE_STEM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

const UNSAFE_NAME_CHARACTERS = /[\\/:*?"<>|\u0000-\u001F\u007F]/gu;

const MAXIMUM_ASSET_NAME_LENGTH = 180;

export const safeBrowserAssetName = (value: string): string => {
  const cleaned = basename(value.normalize("NFKC"))
    .replace(BIDI_CONTROL, "")
    .replace(UNSAFE_NAME_CHARACTERS, "_")
    .replace(/^\.+/u, "")
    .trim();
  // The device prefix is decided, and charged against the length budget, before the cap.
  // Prefixing after the cap produced a name one character over the limit, which is exactly
  // the case the cap exists for.
  const prefix = WINDOWS_DEVICE_STEM.test(cleaned) ? "_" : "";
  const normalized = (prefix + cleaned)
    .slice(0, MAXIMUM_ASSET_NAME_LENGTH)
    // Windows drops a trailing dot or space when it creates a file, so `report.txt.` and
    // `report.txt ` both open `report.txt`. Stripping here keeps the name shown to the user
    // identical to the name that reaches disk. Applied after the length cap, because the cap
    // can itself expose a trailing dot.
    .replace(/[. ]+$/u, "");
  return normalized || "browser-asset";
};

/**
 * EX-3. Where a captured browser asset may be written, and what stops it.
 *
 * Saving an asset is a save dialog and a streamed download; between them sits the safety decision,
 * and it is the part that must never be loosened by accident. The bytes come from a provider page,
 * so the destination is confined to the run's working directory — checked on the parent directory
 * after it is resolved, and again on the file itself, because a symbolic link inside an allowed
 * parent can still point out of it. Nothing is ever overwritten: a name that already exists is
 * refused rather than replaced, and a symbolic link is refused in its own words so the reader
 * knows the file they see is not the file that would be written.
 *
 * The chain lived inside the download closure, reachable only by driving a real provider capture
 * through a real save dialog.
 */
export type BrowserAssetPresence = {
  present: boolean;
  downloadAvailable: boolean;
};

export const browserAssetRefusal = (asset: BrowserAssetPresence): string | undefined => {
  if (!asset.present) return "The browser asset is not present in the transcript";
  return asset.downloadAvailable ? undefined : "This provider asset does not expose downloadable content";
};

export type BrowserAssetDestination = {
  /** The resolved parent directory lies inside the run's working directory. */
  parentInsideWorkspace: boolean;
  /** The file itself lies inside it too, after the parent was resolved. */
  destinationInsideWorkspace: boolean;
  /** What is already at the destination, if anything. */
  existing?: { isSymbolicLink: boolean } | undefined;
};

export const browserAssetDestinationRefusal = (
  destination: BrowserAssetDestination,
): string | undefined => {
  if (!destination.parentInsideWorkspace) {
    return "Browser assets must be saved inside the run working directory";
  }
  if (!destination.destinationInsideWorkspace) {
    return "Browser asset destination is outside the run working directory";
  }
  if (destination.existing) {
    return destination.existing.isSymbolicLink
      ? "Refusing to replace a symbolic link"
      : "Choose a new filename; browser asset saving does not overwrite files";
  }
  return undefined;
};

/**
 * The dialog's title names the origin a response linked the asset from, when that origin is
 * canonical. A path, a query or a full asset URL is never shown, and an origin that is not
 * canonical is not shown at all rather than shown partly.
 */
export const browserAssetSaveTitle = (canonicalOrigin: string | undefined): string | undefined =>
  canonicalOrigin === undefined ? undefined : `Save browser asset linked from ${canonicalOrigin}`;

/**
 * The ceiling on a saved asset. A configured value below the floor would refuse ordinary captures,
 * so the floor wins; there is no ceiling on the ceiling, because the person configuring it is
 * saying what their own disk can take.
 */
export const browserAssetMaximumBytes = (configured: number): number =>
  Math.max(65_536, configured);
