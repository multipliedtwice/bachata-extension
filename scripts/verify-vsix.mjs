import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import yauzl from "yauzl";

import {
  createTrackedTemporaryDirectory,
  removeTrackedTemporaryDirectory,
} from "./lib/temporaryResources.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ARTIFACT_BOUND_RECORDS = new Set([
  "docs/RELEASE_VALIDATION_RECORD.md",
  "docs/PROVIDER_TERMS.md",
  "docs/COMPATIBILITY_MATRIX.md",
  "docs/RELEASE_VERDICT.md",
]);

const requiredEntries = [
  "extension/package.json",
  "extension/LICENSE.txt",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/NO_TELEMETRY.md",
  "extension/dist/LICENSE",
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/webview-behavior.js",
  "extension/dist/THIRD_PARTY_NOTICES.txt",
  "extension/dist/vendor/codicons/LICENSE",
  "extension/dist/vendor/codicons/LICENSE-CODE",
  "extension/scripts/process-scope.cjs",
  "extension/scripts/process-scope.mjs",
  "extension/scripts/windows-job-runner.ps1",
  "extension/scripts/windows-process-host.cjs",
  "extension/node_modules/ajv/package.json",
  "extension/node_modules/fast-glob/package.json",
  "extension/node_modules/ignore/package.json",
  "extension/node_modules/jsonrepair/package.json",
  "extension/node_modules/ts-morph/package.json",
  "extension/node_modules/typescript/package.json",
];

export const requiredVsixEntries = (manifest, repositoryAssets = []) => [
  ...requiredEntries,
  ...[...repositoryAssets, ...manifestAssets(manifest)].map((relative) => `extension/${relative}`),
];

export const missingVsixEntries = (names, required) =>
  required.filter((name) => !names.has(name));

export const unsafeVsixEntryReason = (name) => {
  if (name.length === 0) return "empty entry name";
  if (name.includes("\\")) return "backslash in entry name";
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return "absolute entry path";
  if (name.split("/").some((segment) => segment === ".." || segment === ".")) {
    return "relative traversal segment";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control character in entry name";
  if (!name.startsWith("extension/") && name !== "extension.vsixmanifest" && name !== "[Content_Types].xml") {
    return "entry outside the extension payload";
  }
  return undefined;
};

export const staleVsixEntries = (buildHashes, packagedHashes) =>
  Object.keys(buildHashes)
    .filter((name) => buildHashes[name] !== packagedHashes[name])
    .sort();

const sha256File = async (file) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

export const packagedSourceEquivalence = (firstPartyFiles) =>
  firstPartyFiles.map((relative) => ({
    source: relative,
    packaged: `extension/${relative}`,
  }));

const buildEquivalenceFiles = async (webviewAssets) => Array.from(new Set([
  "dist/extension.js",
  "dist/webview/assets.js",
  "dist/webview/html.js",
  ...webviewAssets,
  ...await repositoryFiles("dist"),
]));

const RENAMED_SOURCES = new Set(["README.md", "CHANGELOG.md", "LICENSE"]);
const MANIFEST_EXCLUDED_ROOTS = new Set(["dist", "node_modules"]);

const isDirectory = async (relative) => {
  try {
    return (await stat(path.join(repositoryRoot, relative))).isDirectory();
  } catch {
    return false;
  }
};

export const shippedSourceFiles = async (manifest) => {
  const declared = Array.isArray(manifest.files) ? manifest.files : [];
  const entries = [];
  for (const relative of declared) {
    const normalized = relative.replace(/^\.\//u, "").replace(/\/$/u, "");
    if (MANIFEST_EXCLUDED_ROOTS.has(normalized.split("/")[0])) continue;
    if (RENAMED_SOURCES.has(normalized)) continue;
    entries.push(...(await isDirectory(normalized) ? await repositoryFiles(normalized) : [normalized]));
  }
  const unique = Array.from(new Set(entries)).sort();
  const packagedRecords = unique.filter((relative) => ARTIFACT_BOUND_RECORDS.has(relative));
  if (packagedRecords.length > 0) {
    throw new Error(
      `package.json "files" declares artifact-binding records: ${packagedRecords.join(", ")}. Remove them; packaging a document that names the artifact's own hash makes that hash unstable.`,
    );
  }
  return unique;
};

const renamedSourceFiles = [
  { source: "README.md", packaged: "extension/readme.md" },
  { source: "CHANGELOG.md", packaged: "extension/changelog.md" },
  { source: "LICENSE", packaged: "extension/LICENSE.txt" },
];

const repositoryFiles = async (relativeDirectory) => {
  const absolute = path.join(repositoryRoot, relativeDirectory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      files.push(`${relative} is a symbolic link in this checkout`);
      continue;
    }
    if (entry.isDirectory()) files.push(...await repositoryFiles(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
};

export const manifestAssets = (manifest) => {
  const values = [];
  if (typeof manifest.main === "string") values.push(manifest.main.replace(/^\.\//u, ""));
  if (typeof manifest.icon === "string") values.push(manifest.icon);
  for (const snippet of manifest.contributes?.snippets ?? []) {
    if (typeof snippet.path === "string") values.push(snippet.path.replace(/^\.\//u, ""));
  }
  for (const walkthrough of manifest.contributes?.walkthroughs ?? []) {
    for (const step of walkthrough.steps ?? []) {
      for (const media of Object.values(step.media ?? {})) {
        if (typeof media === "string") values.push(media);
      }
    }
  }
  return values;
};

// npm applies exclusions before allowlists: a `!` entry removes a value whatever the
// positive list says, and an empty positive list means "everything not excluded".
export const packagePlatformSatisfied = (entry, target) => {
  const matches = (values, actual) => {
    if (!Array.isArray(values) || values.length === 0) return true;
    const excluded = values
      .filter((value) => typeof value === "string" && value.startsWith("!"))
      .map((value) => value.slice(1));
    if (excluded.includes(actual)) return false;
    const allowed = values.filter((value) => typeof value === "string" && !value.startsWith("!"));
    return allowed.length === 0 || allowed.includes(actual);
  };
  return matches(entry?.os, target.platform) &&
    matches(entry?.cpu, target.arch) &&
    (target.platform !== "linux" || matches(entry?.libc, target.libc));
};

export const runningPlatform = () => ({
  platform: process.platform,
  arch: process.arch,
  libc: process.report?.getReport?.()?.header?.glibcVersionRuntime ? "glibc" : "musl",
});

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip));
});

export const MAXIMUM_VSIX_RECORDS = 20_000;
export const MAXIMUM_VSIX_ENTRY_BYTES = 64 * 1_048_576;
export const MAXIMUM_VSIX_TOTAL_BYTES = 512 * 1_048_576;
export const MAXIMUM_VSIX_ARCHIVE_BYTES = 256 * 1_048_576;

export const verifyVsix = async (file) => {
  const archive = await stat(file);
  if (archive.size > MAXIMUM_VSIX_ARCHIVE_BYTES) {
    throw new Error(
      `VSIX is ${String(archive.size)} bytes, above the ${String(MAXIMUM_VSIX_ARCHIVE_BYTES)}-byte limit this verifier will open`,
    );
  }
  const destination = await createTrackedTemporaryDirectory(path.join(os.tmpdir(), "bachata-vsix-"));
  let verificationError;
  try {
    const zip = await openZip(file);
    const names = new Set();
    const collisionKeys = new Map();
    let records = 0;
    let totalBytes = 0;
    await new Promise((resolve, reject) => {
      let settled = false;
      let activeStream;
      const settle = (error) => {
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
        else resolve(undefined);
      };
      const refuse = (message) => settle(new Error(message));
      zip.on("error", settle);
      zip.on("end", () => settle());
      zip.on("entry", (entry) => {
        const name = entry.fileName;
        records += 1;
        if (records > MAXIMUM_VSIX_RECORDS) {
          refuse(`VSIX declares more than ${String(MAXIMUM_VSIX_RECORDS)} records`);
          return;
        }
        const reason = unsafeVsixEntryReason(name.endsWith("/") ? name.slice(0, -1) : name);
        if (reason) {
          refuse(`Unsafe VSIX entry: ${name} (${reason})`);
          return;
        }
        if (names.has(name)) {
          refuse(`Duplicate VSIX entry: ${name}`);
          return;
        }
        const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
        if (trimmed.split("/").some((segment) => segment.length === 0)) {
          refuse(`VSIX entry has an empty path segment: ${name}`);
          return;
        }
        const windowsAlias = trimmed.split("/").some((segment) =>
          segment.includes(":") || /[. ]$/u.test(segment) ||
          /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b2\u00b3\u00b9]|lpt[1-9\u00b2\u00b3\u00b9])(?:\.|$)/iu
            .test(segment.replace(/[. ]+$/u, "")));
        if (windowsAlias) {
          refuse(`VSIX entry is ambiguous on Windows: ${name}`);
          return;
        }
        const collisionKey = path.posix.normalize(trimmed).normalize("NFC").toLowerCase();
        if (collisionKeys.has(collisionKey)) {
          refuse(
            `VSIX entries collide once normalized: ${name} and ${collisionKeys.get(collisionKey)}`,
          );
          return;
        }
        collisionKeys.set(collisionKey, name);
        if (entry.uncompressedSize > MAXIMUM_VSIX_ENTRY_BYTES) {
          refuse(
            `VSIX entry ${name} declares ${String(entry.uncompressedSize)} bytes, above the ${String(MAXIMUM_VSIX_ENTRY_BYTES)}-byte entry limit`,
          );
          return;
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAXIMUM_VSIX_TOTAL_BYTES) {
          refuse(
            `VSIX exceeds the ${String(MAXIMUM_VSIX_TOTAL_BYTES)}-byte uncompressed limit before extraction`,
          );
          return;
        }
        names.add(name);
        if (name.endsWith("/")) {
          mkdir(path.join(destination, name), { recursive: true }).then(() => zip.readEntry(), settle);
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) { settle(error); return; }
          activeStream = stream;
          const target = path.join(destination, name);
          mkdir(path.dirname(target), { recursive: true }).then(() => {
            const output = createWriteStream(target);
            stream.on("error", settle);
            output.on("error", settle);
            output.on("close", () => {
              if (settled) return;
              activeStream = undefined;
              zip.readEntry();
            });
            stream.pipe(output);
          }, settle);
        });
      });
      zip.readEntry();
    });
    const packagedManifest = JSON.parse(
      await readFile(path.join(destination, "extension/package.json"), "utf8"),
    );
    const repositoryManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    );
    const manifestDifferences = (left, right, trail = "") => {
      const keys = Array.from(new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]));
      return keys.flatMap((key) => {
        const path = trail ? `${trail}.${key}` : key;
        const a = left?.[key];
        const b = right?.[key];
        if (JSON.stringify(a) === JSON.stringify(b)) return [];
        if (a && b && typeof a === "object" && typeof b === "object" &&
          !Array.isArray(a) && !Array.isArray(b)) {
          return manifestDifferences(a, b, path);
        }
        return [path];
      });
    };
    const differences = manifestDifferences(repositoryManifest, packagedManifest);
    if (differences.length > 0) {
      throw new Error(
        `The packaged manifest does not match this repository's package.json. Differing keys: ${differences.slice(0, 20).join(", ")}`,
      );
    }
    const localAssetsPath = path.join(repositoryRoot, "dist/webview/assets.js");
    let assetsModule;
    try {
      assetsModule = await import(pathToFileURL(localAssetsPath).href);
    } catch (error) {
      throw new Error(
        `The current build has no usable dist/webview/assets.js webview asset manifest; run npm run build: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const webviewAssets = assetsModule.webviewRuntimeAssets?.();
    if (!Array.isArray(webviewAssets) || webviewAssets.length === 0) {
      throw new Error("The current build declares no webview runtime assets");
    }
    if (!names.has("extension/dist/webview/assets.js")) {
      throw new Error("VSIX is missing extension/dist/webview/assets.js");
    }
    const required = requiredVsixEntries(packagedManifest, [
      ...await repositoryFiles("presets"),
      ...await repositoryFiles("protocol"),
      ...webviewAssets,
    ]);

    const missing = missingVsixEntries(names, required);
    if (missing.length > 0) {
      throw new Error(`VSIX is missing ${missing.join(", ")}`);
    }
    if (packagedManifest.publisher !== repositoryManifest.publisher) {
      throw new Error(
        `VSIX was packaged as publisher "${String(packagedManifest.publisher)}" but this repository declares "${String(repositoryManifest.publisher)}"`,
      );
    }
    if (packagedManifest.version !== repositoryManifest.version) {
      throw new Error(
        `VSIX declares version ${String(packagedManifest.version)} but this repository declares ${String(repositoryManifest.version)}`,
      );
    }
    const equivalencePairs = [
      ...packagedSourceEquivalence(Array.from(new Set([
        ...await buildEquivalenceFiles(webviewAssets),
        ...await shippedSourceFiles(repositoryManifest),
      ]))),
      ...renamedSourceFiles,
    ];
    const packagedDependencyFiles = [...names]
      .filter((name) => name.startsWith("extension/node_modules/") && !name.endsWith("/"))
      .sort();
    const lockfile = JSON.parse(
      await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
    );
    const platformSatisfied = (entry) => packagePlatformSatisfied(entry, runningPlatform());
    // An optional dependency npm skips on this platform may legitimately be absent from
    // the package. A required one may not: a platform predicate never excuses its absence,
    // so it stays in the expected closure and its absence fails this verification.
    const productionEntries = Object.entries(lockfile.packages ?? {})
      .filter(([name, entry]) => name.startsWith("node_modules/") && entry?.dev !== true);
    const skippableOptionalPackages = new Set(
      productionEntries
        .filter(([, entry]) => entry?.optional === true && !platformSatisfied(entry))
        .map(([name]) => name),
    );
    const lockedProductionPackages = productionEntries
      .map(([name]) => name)
      .filter((name) => !skippableOptionalPackages.has(name))
      .sort();
    if (lockedProductionPackages.length === 0) {
      throw new Error("package-lock.json declares no production dependency closure to verify against");
    }
    const packagedDependencyPackages = Array.from(new Set(
      packagedDependencyFiles.map((name) => {
        const segments = name.slice("extension/node_modules/".length).split("/");
        return segments[0]?.startsWith("@")
          ? `node_modules/${segments[0]}/${segments[1]}`
          : `node_modules/${segments[0]}`;
      }),
    )).sort();
    const missingPackages = lockedProductionPackages
      .filter((name) => !packagedDependencyPackages.includes(name));
    const unexpectedPackages = packagedDependencyPackages
      .filter((name) => !lockedProductionPackages.includes(name));
    if (missingPackages.length > 0 || unexpectedPackages.length > 0) {
      throw new Error(
        `The VSIX production dependency set does not match the ${String(lockedProductionPackages.length)}-package locked closure. Missing: ${missingPackages.join(", ") || "none"}. Unexpected: ${unexpectedPackages.join(", ") || "none"}.`,
      );
    }
    const localDependencyFiles = [];
    for (const relative of lockedProductionPackages) {
      try {
        const rootDetails = await lstat(path.join(repositoryRoot, relative));
        if (rootDetails.isSymbolicLink()) {
          localDependencyFiles.push(`${relative} is a symbolic link in this checkout`);
          continue;
        }
        localDependencyFiles.push(...await repositoryFiles(relative));
      } catch (error) {
        if ((error && error.code) !== "ENOENT") throw error;
        localDependencyFiles.push(`${relative} is not installed in this checkout`);
      }
    }
    const packagedDependencySources = new Set(
      packagedDependencyFiles.map((name) => name.slice("extension/".length)),
    );
    const dependencyMismatches = [];
    for (const relative of localDependencyFiles) {
      if (relative.endsWith(" is not installed in this checkout") ||
        relative.endsWith(" is a symbolic link in this checkout")) {
        dependencyMismatches.push(relative);
        continue;
      }
      if (!packagedDependencySources.has(relative)) {
        dependencyMismatches.push(`${relative} is installed here but missing from the VSIX`);
      }
    }
    for (const source of packagedDependencySources) {
      const local = path.join(repositoryRoot, source);
      const details = await lstat(local).catch(() => undefined);
      if (details === undefined) {
        dependencyMismatches.push(`${source} is packaged but not installed in this checkout`);
        continue;
      }
      if (details.isSymbolicLink()) {
        dependencyMismatches.push(`${source} is a symbolic link in this checkout`);
        continue;
      }
      if (await sha256File(local).catch(() => undefined) !==
        await sha256File(path.join(destination, `extension/${source}`)).catch(() => undefined)) {
        dependencyMismatches.push(source);
      }
    }
    if (dependencyMismatches.length > 0) {
      throw new Error(
        `The VSIX production dependency closure does not match this locked checkout, so nothing from it may be executed: ${Array.from(new Set(dependencyMismatches)).slice(0, 20).join(", ")}`,
      );
    }
    const packagedRuntimeFiles = [...names]
      .filter((name) => name.startsWith("extension/dist/") && !name.endsWith("/"));
    const equivalentPackaged = new Set(equivalencePairs.map((pair) => pair.packaged));
    const unverified = packagedRuntimeFiles
      .filter((name) => !equivalentPackaged.has(name))
      .filter((name) => !name.startsWith("extension/dist/vendor/"))
      .sort();
    if (unverified.length > 0) {
      throw new Error(
        `VSIX ships runtime files that this build cannot vouch for: ${unverified.slice(0, 20).join(", ")}`,
      );
    }
    const packagedRecords = [...ARTIFACT_BOUND_RECORDS]
      .filter((relative) => names.has(`extension/${relative}`))
      .sort();
    if (packagedRecords.length > 0) {
      throw new Error(
        `VSIX packages artifact-binding records, which makes its own hash unstable: ${packagedRecords.join(", ")}. Remove them from the package.json "files" property; do not add a .vscodeignore, because VSCE refuses a package that declares both.`,
      );
    }
    const buildHashes = {};
    const packagedHashes = {};
    for (const pair of equivalencePairs) {
      const local = path.join(repositoryRoot, pair.source);
      const packaged = path.join(destination, pair.packaged);
      try {
        buildHashes[pair.source] = await sha256File(local);
      } catch (error) {
        throw new Error(
          `The current source or build is missing ${pair.source}; run npm run build before verifying: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      packagedHashes[pair.source] = await sha256File(packaged).catch(() => undefined);
    }
    const equivalenceFiles = equivalencePairs;
    const stale = staleVsixEntries(buildHashes, packagedHashes);
    if (stale.length > 0) {
      throw new Error(
        `VSIX does not match the current build. Rebuild and repackage. Differing files: ${stale.join(", ")}`,
      );
    }
    for (const devPackage of ["@vscode/vsce", "@vscode/codicons", "prismjs", "yauzl"]) {
      const prefix = `extension/node_modules/${devPackage}/`;
      if ([...names].some((name) => name.startsWith(prefix))) {
        throw new Error(`VSIX includes development-only package ${devPackage}`);
      }
    }
    const notices = await readFile(path.join(destination, "extension/dist/THIRD_PARTY_NOTICES.txt"), "utf8");
    for (const name of ["ajv", "fast-glob", "ignore", "jsonrepair", "ts-morph", "typescript", "prismjs", "@vscode/codicons"]) {
      if (!notices.includes(`${name}@`)) throw new Error(`Notices are missing ${name}`);
    }
    const entry = path.join(destination, "extension/dist/extension.js");
    await access(entry);
    // Every packaged file that this smoke run can load — the entry, its dist tree, and
    // every production dependency — has been byte-compared with this locked checkout above.
    const smoke = spawnSync(process.execPath, [path.resolve("scripts/verify-packaged-extension.cjs"), entry], {
      cwd: destination,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      windowsHide: true,
    });
    if (smoke.status !== 0) {
      throw new Error(`Packaged extension module-load smoke failed:\n${smoke.stderr || smoke.stdout}`);
    }
    const artifact = await stat(file);
    console.log(
      `Verified ${path.basename(file)} (${String(names.size)} files, ${String(artifact.size)} bytes, ${String(equivalenceFiles.length)} build-equivalent runtime files)`,
    );
  } catch (error) {
    verificationError = error;
  }
  const removalFailure = removeTrackedTemporaryDirectory(destination) &&
    removeTrackedTemporaryDirectory(destination);
  if (removalFailure) {
    const removal = new Error(
      `Could not remove the VSIX extraction directory ${destination}: ${removalFailure}`,
    );
    if (verificationError) {
      throw new AggregateError(
        [verificationError, removal],
        `VSIX verification failed and its extraction directory could not be removed: ${
          verificationError instanceof Error ? verificationError.message : String(verificationError)
        }`,
      );
    }
    throw removal;
  }
  if (verificationError) throw verificationError;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const file = process.argv[2];
  if (!file) throw new Error("Expected VSIX path");
  await verifyVsix(path.resolve(file));
}
