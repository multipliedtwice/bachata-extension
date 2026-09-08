import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

import yauzl from "yauzl";

export const MAXIMUM_BRIDGE_ENTRIES = 512;
export const MAXIMUM_BRIDGE_ENTRY_BYTES = 8 * 1_048_576;
export const MAXIMUM_BRIDGE_TOTAL_BYTES = 64 * 1_048_576;

export const unsafeBridgeEntryReason = (name) => {
  if (name.length === 0) return "empty entry name";
  if (name.includes("\\")) return "backslash in entry name";
  if (name.startsWith("/") || /^[a-zA-Z]:/u.test(name)) return "absolute entry path";
  if (name.split("/").some((segment) => segment === ".." || segment === ".")) {
    return "relative traversal segment";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(name)) return "control character in entry name";
  return undefined;
};

const hashArchive = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
    if (openError) {
      reject(openError);
      return;
    }
    const digests = new Map();
    const directories = new Set();
    const collisionKeys = new Map();
    let totalBytes = 0;
    let settled = false;
    let activeStream;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      try {
        activeStream?.destroy();
      } catch {
        // The stream is already closed; the settlement below is the outcome.
      }
      try {
        zip.close();
      } catch {
        // The archive is already closed; the settlement below is the outcome.
      }
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (message) => settle(new Error(message));
    zip.on("error", (error) => settle(error));
    zip.on("end", () => settle(undefined, { digests, directories, totalBytes }));
    let records = 0;
    const seen = new Set();
    zip.on("entry", (entry) => {
      const name = entry.fileName;
      records += 1;
      if (records > MAXIMUM_BRIDGE_ENTRIES) {
        fail(`Browser Bridge ZIP declares more than ${String(MAXIMUM_BRIDGE_ENTRIES)} records`);
        return;
      }
      if (seen.has(name)) {
        fail(`Duplicate Browser Bridge entry: ${name}`);
        return;
      }
      seen.add(name);
      const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
      const directoryReason = unsafeBridgeEntryReason(trimmed);
      if (directoryReason) {
        fail(`Unsafe Browser Bridge entry: ${name} (${directoryReason})`);
        return;
      }
      const collisionKey = trimmed.normalize("NFC").toLowerCase();
      if (collisionKeys.has(collisionKey)) {
        fail(
          `Browser Bridge entries collide once normalized: ${name} and ${collisionKeys.get(collisionKey)}`,
        );
        return;
      }
      collisionKeys.set(collisionKey, name);
      if (name.endsWith("/")) {
        if (entry.uncompressedSize !== 0 || entry.compressedSize !== 0) {
          fail(
            `Browser Bridge directory record ${name} declares ${String(entry.uncompressedSize)} uncompressed and ${String(entry.compressedSize)} compressed bytes; a directory record must carry no data`,
          );
          return;
        }
        directories.add(name.slice(0, -1));
        zip.readEntry();
        return;
      }
      if (digests.size >= MAXIMUM_BRIDGE_ENTRIES) {
        fail(`Browser Bridge ZIP declares more than ${String(MAXIMUM_BRIDGE_ENTRIES)} entries`);
        return;
      }
      if (entry.uncompressedSize > MAXIMUM_BRIDGE_ENTRY_BYTES) {
        fail(
          `Browser Bridge entry ${name} declares ${String(entry.uncompressedSize)} bytes, above the ${String(MAXIMUM_BRIDGE_ENTRY_BYTES)}-byte entry limit`,
        );
        return;
      }
      if (totalBytes + entry.uncompressedSize > MAXIMUM_BRIDGE_TOTAL_BYTES) {
        fail(
          `Browser Bridge ZIP exceeds the ${String(MAXIMUM_BRIDGE_TOTAL_BYTES)}-byte uncompressed limit`,
        );
        return;
      }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError) {
          settle(streamError);
          return;
        }
        activeStream = stream;
        const digest = createHash("sha256");
        let entryBytes = 0;
        let manifest = name === "manifest.json" ? [] : undefined;
        stream.on("data", (chunk) => {
          entryBytes += chunk.length;
          if (entryBytes > MAXIMUM_BRIDGE_ENTRY_BYTES) {
            stream.destroy();
            fail(`Browser Bridge entry ${name} streams more bytes than it declares`);
            return;
          }
          digest.update(chunk);
          if (manifest) manifest.push(chunk);
        });
        stream.on("error", (error) => settle(error));
        stream.on("end", () => {
          if (settled) return;
          activeStream = undefined;
          if (entryBytes !== entry.uncompressedSize) {
            fail(
              `Browser Bridge entry ${name} streams ${String(entryBytes)} bytes but declares ${String(entry.uncompressedSize)}`,
            );
            return;
          }
          totalBytes += entryBytes;
          digests.set(name, {
            digest: digest.digest("hex"),
            bytes: entryBytes,
            ...(manifest ? { contents: Buffer.concat(manifest) } : {}),
          });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
});

const directoryFiles = async (root, prefix = "", directories = new Set()) => {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Browser Bridge source tree contains a symbolic link: ${relative}`);
    }
    if (entry.isDirectory()) {
      directories.add(relative);
      files.push(...await directoryFiles(root, relative, directories));
      continue;
    }
    if (entry.isFile()) files.push(relative);
  }
  files.directories = directories;
  return files;
};

const sourceDigest = async (file) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

export const verifyBridgeArchive = async (file, pinned, options = {}) => {
  const { digests, directories } = await hashArchive(file);
  const unsafe = [...digests.keys()]
    .map((name) => ({ name, reason: unsafeBridgeEntryReason(name) }))
    .filter((entry) => entry.reason !== undefined);
  if (unsafe.length > 0) {
    throw new Error(
      `Unsafe Browser Bridge entries: ${unsafe.map((entry) => `${entry.name} (${entry.reason})`).join(", ")}`,
    );
  }
  const manifestEntry = digests.get("manifest.json");
  if (!manifestEntry) {
    throw new Error("Browser Bridge ZIP is missing manifest.json");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.contents.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Browser Bridge manifest.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.version !== pinned.version) {
    throw new Error(
      `Browser Bridge ZIP declares version ${String(manifest.version)}, but this release pins ${pinned.version}`,
    );
  }
  if (manifest.manifest_version !== 3) {
    throw new Error(
      `Browser Bridge manifest declares manifest_version ${String(manifest.manifest_version)}; the extension requires 3`,
    );
  }
  const optionsPage = manifest.options_ui?.page ?? manifest.options_page;
  const declaredFiles = [
    ...(typeof manifest.background?.service_worker === "string"
      ? [manifest.background.service_worker]
      : []),
    ...(manifest.content_scripts ?? []).flatMap((script) => [
      ...(script.js ?? []),
      ...(script.css ?? []),
    ]),
    ...(typeof manifest.action?.default_popup === "string" ? [manifest.action.default_popup] : []),
    ...(typeof optionsPage === "string" ? [optionsPage] : []),
    ...(typeof manifest.side_panel?.default_path === "string"
      ? [manifest.side_panel.default_path]
      : []),
    ...(typeof manifest.devtools_page === "string" ? [manifest.devtools_page] : []),
    ...(typeof manifest.chrome_url_overrides === "object" && manifest.chrome_url_overrides !== null
      ? Object.values(manifest.chrome_url_overrides)
      : []),
    ...(manifest.sandbox?.pages ?? []),
    ...(manifest.declarative_net_request?.rule_resources ?? [])
      .map((resource) => (resource && typeof resource === "object" ? resource.path : undefined)),
    ...(typeof manifest.storage?.managed_schema === "string"
      ? [manifest.storage.managed_schema]
      : []),
    ...(manifest.file_handlers ?? [])
      .map((handler) => (handler && typeof handler === "object" ? handler.action : undefined)),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...(manifest.web_accessible_resources ?? [])
      .flatMap((entry) => (entry && typeof entry === "object" ? entry.resources ?? [] : [])),
  ].filter((name) => typeof name === "string" && !name.includes("*"));
  const missingFiles = declaredFiles
    .map((name) => name.replace(/^\.\//u, ""))
    .filter((name) => !digests.has(name));
  if (missingFiles.length > 0) {
    throw new Error(
      `Browser Bridge manifest declares files the archive does not carry: ${missingFiles.join(", ")}`,
    );
  }

  const sourceRoot = options.sourceRoot;
  let compared = 0;
  if (options.requireSource !== false) {
    if (sourceRoot === undefined) {
      throw new Error(
        "The Browser Bridge build directory was not found, so the archive cannot be compared with the build it was packaged from.",
      );
    }
    const rootDetails = await lstat(sourceRoot);
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
      throw new Error(
        `The Browser Bridge build directory ${sourceRoot} is not a regular directory this checkout owns.`,
      );
    }
    {
      const sourceDirectorySet = new Set();
      const sourceFiles = await directoryFiles(sourceRoot, "", sourceDirectorySet);
      const sourceDirectories = sourceDirectorySet;
      const packaged = new Set([...digests.keys(), ...directories]);
      const source = new Set([...sourceFiles, ...sourceDirectories]);
      const missingFromArchive = sourceFiles.filter((name) => !packaged.has(name)).sort();
      const unexpectedInArchive = [...packaged].filter((name) => !source.has(name)).sort();
      if (missingFromArchive.length > 0 || unexpectedInArchive.length > 0) {
        throw new Error(
          `Browser Bridge ZIP is not the exact packaged build. Missing: ${missingFromArchive.slice(0, 20).join(", ") || "none"}. Unexpected: ${unexpectedInArchive.slice(0, 20).join(", ") || "none"}.`,
        );
      }
      const differing = [];
      for (const name of sourceFiles) {
        const local = await sourceDigest(path.join(sourceRoot, name));
        if (local !== digests.get(name).digest) differing.push(name);
      }
      if (differing.length > 0) {
        throw new Error(
          `Browser Bridge ZIP entries differ from the build they were packaged from: ${differing.slice(0, 20).join(", ")}`,
        );
      }
      compared = sourceFiles.length;
    }
    if (compared !== digests.size) {
      throw new Error(
        `The Browser Bridge archive holds ${String(digests.size)} entries but only ${String(compared)} were compared with its build.`,
      );
    }
  }

  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  return { entries: digests.size, version: manifest.version, digest, declaredFiles, compared };
};

export const bridgeSourceRoot = async (archiveFile) => {
  const candidate = path.join(path.dirname(archiveFile), "dist");
  try {
    const details = await lstat(candidate);
    return details.isDirectory() && !details.isSymbolicLink() ? candidate : undefined;
  } catch {
    return undefined;
  }
};
