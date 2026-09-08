import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";

import { readZipEntryFromBuffer } from "./zipEntry.mjs";
import { openVerifiedRegularFile } from "./verifiedRegularFile.mjs";
import * as path from "node:path";

export const BRIDGE_COMPATIBILITY_PATH = "protocol/browser-bridge.compatibility.json";

// The Browser Bridge package directory is unversioned; the versioned form is only still
// consulted so a checkout made before the rename resolves the same archive.
export const BRIDGE_PACKAGE_DIRECTORY = "browser-bridge";

export const pinnedBridgeRelease = async (root) => {
  const source = await readFile(path.join(root, ...BRIDGE_COMPATIBILITY_PATH.split("/")), "utf8");
  const value = JSON.parse(source);
  const name = value.browserBridgePackage;
  const version = value.browserBridgeVersion;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(
      `${BRIDGE_COMPATIBILITY_PATH} does not pin browserBridgePackage and browserBridgeVersion`,
    );
  }
  return { name, version, fileName: `${name}-${version}.zip` };
};

const regularFile = async (candidate) => {
  try {
    const details = await lstat(candidate);
    if (details.isSymbolicLink()) {
      throw new Error(
        `${candidate} is a symbolic link. A release artifact must be a regular file this checkout owns.`,
      );
    }
    return details.isFile() ? candidate : undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes("symbolic link")) throw error;
    return undefined;
  }
};

export const readArtifactSnapshot = async (candidate, manifestEntry, label, limits = {}) => {
  const opened = await openPinnedArtifact(candidate, limits);
  const bytes = await readZipEntryFromBuffer(
    opened.bytes,
    label ?? candidate,
    manifestEntry,
    limits.entry ?? {},
  );
  if (!bytes) {
    throw new Error(`${label ?? candidate} has no ${manifestEntry} manifest`);
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label ?? candidate} manifest ${manifestEntry} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof manifest.version !== "string") {
    throw new Error(`${label ?? candidate} declares no version in ${manifestEntry}`);
  }
  return {
    path: opened.path,
    bytes: opened.bytes,
    size: opened.size,
    sha256: createHash("sha256").update(opened.bytes).digest("hex"),
    version: manifest.version,
    manifest,
  };
};

export const MAXIMUM_ARTIFACT_BYTES = 256 * 1_048_576;

export const VSIX_ARTIFACT_LIMITS = {
  maximumBytes: 256 * 1_048_576,
  entry: { maximumDeclaredBytes: 512 * 1_048_576 },
};

export const BRIDGE_ARTIFACT_LIMITS = {
  maximumBytes: 64 * 1_048_576,
  entry: { maximumDeclaredBytes: 64 * 1_048_576 },
};

export const openPinnedArtifact = async (candidate, limits = {}) => {
  const { handle, details } = await openVerifiedRegularFile(candidate);
  try {
    const maximumBytes = limits.maximumBytes ?? MAXIMUM_ARTIFACT_BYTES;
    if (details.size > maximumBytes) {
      throw new Error(
        `${candidate} is ${String(details.size)} bytes, above the ${String(maximumBytes)}-byte limit this release reads into memory`,
      );
    }
    const size = Number(details.size);
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const chunk = await handle.read(bytes, read, Math.min(1_048_576, size - read), read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    if (read !== size) {
      throw new Error(`${candidate} ended after ${String(read)} of ${String(details.size)} bytes`);
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== details.size) {
      throw new Error(
        `${candidate} changed size while it was being read: ${String(details.size)} bytes became ${String(after.size)}`,
      );
    }
    if (after.dev !== details.dev || after.ino !== details.ino) {
      throw new Error(`${candidate} was replaced while it was being read`);
    }
    if (after.mtimeNs !== details.mtimeNs || after.ctimeNs !== details.ctimeNs) {
      throw new Error(`${candidate} was rewritten in place while it was being read`);
    }
    return { path: candidate, bytes, size };
  } finally {
    await handle.close();
  }
};

export const resolvePinnedBridgeArchive = async (root) => {
  const pinned = await pinnedBridgeRelease(root);
  const parent = path.resolve(root, "..");
  const packageDirectories = [
    BRIDGE_PACKAGE_DIRECTORY,
    `${pinned.name}-${pinned.version}`,
  ];
  const candidates = [
    path.join(root, pinned.fileName),
    path.join(parent, pinned.fileName),
    ...packageDirectories.map((directory) => path.join(parent, directory, pinned.fileName)),
  ];
  const found = [];
  for (const candidate of candidates) {
    const resolved = await regularFile(candidate);
    if (resolved) found.push(resolved);
  }
  const unpinned = new Set();
  for (const directory of [parent, root]) {
    const siblings = await readdir(directory, { withFileTypes: true }).catch(() => []);
    siblings
      .filter((entry) => entry.isDirectory() || /\.zip$/u.test(entry.name))
      .filter((entry) => entry.name.startsWith(`${pinned.name}-`))
      .filter((entry) => entry.name !== `${pinned.name}-${pinned.version}` &&
        entry.name !== pinned.fileName)
      .forEach((entry) => unpinned.add(entry.name));
  }
  for (const directory of packageDirectories) {
    const nested = await readdir(path.join(parent, directory), { withFileTypes: true }).catch(() => []);
    // A competing *version of this package* is what may not sit beside the pinned one. The
    // sibling scan above already reads it that way; an unrelated archive that happens to live
    // inside the Bridge checkout names no version of anything and is not a release candidate.
    nested
      .filter((entry) => entry.isFile() && /\.zip$/u.test(entry.name))
      .filter((entry) => entry.name.startsWith(`${pinned.name}-`) && entry.name !== pinned.fileName)
      .forEach((entry) => unpinned.add(`${directory}/${entry.name}`));
  }
  if (unpinned.size > 0) {
    throw new Error(
      `${BRIDGE_COMPATIBILITY_PATH} pins ${pinned.fileName}, but this checkout also holds ${[...unpinned].sort().join(", ")}. Remove the versions this release does not pin.`,
    );
  }
  if (found.length === 0) {
    throw new Error(
      `${BRIDGE_COMPATIBILITY_PATH} pins ${pinned.fileName}, which was not found beside this repository.`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `${BRIDGE_COMPATIBILITY_PATH} pins ${pinned.fileName}, but this checkout holds ${String(found.length)} copies: ${found.join(", ")}. Keep exactly one.`,
    );
  }
  const snapshot = await readArtifactSnapshot(
    found[0],
    "manifest.json",
    pinned.fileName,
    BRIDGE_ARTIFACT_LIMITS,
  );
  if (snapshot.version !== pinned.version) {
    throw new Error(
      `${found[0]} declares version ${snapshot.version}, but this release pins ${pinned.version}`,
    );
  }
  return { ...pinned, ...snapshot };
};
