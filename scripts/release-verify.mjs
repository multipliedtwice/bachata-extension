import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { verifyVsix } from "./verify-vsix.mjs";
import { bridgeSourceRoot, verifyBridgeArchive } from "./verify-bridge.mjs";
import {
  VSIX_ARTIFACT_LIMITS,
  readArtifactSnapshot,
  resolvePinnedBridgeArchive,
} from "./lib/releaseArtifacts.mjs";
import {
  createTrackedTemporaryDirectory,
  removeEveryTrackedTemporaryDirectory,
  trackedTemporaryDirectories,
} from "./lib/temporaryResources.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const digestOf = async (file) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const vsixName = `bachata-vscode-${manifest.version}.vsix`;
const vsixPath = path.join(root, vsixName);

// This command verifies a candidate that already exists; it never builds one. An absent
// candidate is the ordinary state of a tree that has not been packaged yet, so it is
// reported as one instruction rather than as an unhandled ENOENT from the open() below.
const readStagedVsix = async () => {
  try {
    return await readArtifactSnapshot(
      vsixPath,
      "extension/package.json",
      vsixName,
      VSIX_ARTIFACT_LIMITS,
    );
  } catch (error) {
    if ((error && error.code) !== "ENOENT") throw error;
    console.error(
      `No staged ${vsixName} was found at ${vsixPath}.\n`
      + "release:verify verifies an existing candidate; it does not build one. Build the candidate with\n"
      + "  npm run package\n"
      + `then bind the release records to the hash it prints with \`npm run release:bind\`, and run this command again.`,
    );
    return undefined;
  }
};

const verify = async () => {
  const vsixSnapshot = await readStagedVsix();
  if (!vsixSnapshot) {
    process.exitCode = 1;
    return;
  }
  const pinnedBridge = await resolvePinnedBridgeArchive(root);
  const bridgePath = pinnedBridge.path;
  const snapshotRoot = await createTrackedTemporaryDirectory(
    path.join(os.tmpdir(), "bachata-release-verify-"),
  );
  const artifacts = [
    {
      label: "Bachata VSIX",
      source: vsixSnapshot.path,
      bytes: vsixSnapshot.bytes,
      digest: vsixSnapshot.sha256,
      snapshot: path.join(snapshotRoot, path.basename(vsixSnapshot.path)),
    },
    {
      label: "Browser Bridge ZIP",
      source: pinnedBridge.path,
      bytes: pinnedBridge.bytes,
      digest: pinnedBridge.sha256,
      snapshot: path.join(snapshotRoot, path.basename(pinnedBridge.path)),
    },
  ];

  for (const artifact of artifacts) {
    await writeFile(artifact.snapshot, artifact.bytes, { flag: "wx", mode: 0o400 });
    if (await digestOf(artifact.snapshot) !== artifact.digest) {
      throw new Error(`The ${artifact.label} snapshot does not match the bytes that were read.`);
    }
    console.log(`Snapshotted ${artifact.label} ${artifact.digest}`);
  }

  const metadata = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "check-release-metadata.mjs"),
      "--stage=all",
      `--target=${process.argv.slice(2).find((value) => value.startsWith("--target="))?.slice("--target=".length) ?? process.env.RELEASE_PUBLICATION_TARGET ?? "both"}`,
      `--vsix=${artifacts[0].snapshot}`,
      `--bridge=${artifacts[1].snapshot}`,
    ],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  if (metadata.error) throw metadata.error;

  const structuralErrors = [];
  try {
    await verifyVsix(artifacts[0].snapshot);
  } catch (error) {
    structuralErrors.push(error);
  }
  try {
    const bridge = await verifyBridgeArchive(artifacts[1].snapshot, pinnedBridge, {
      sourceRoot: await bridgeSourceRoot(bridgePath, pinnedBridge),
    });
    console.log(
      `Verified Browser Bridge ZIP ${bridge.version}: ${String(bridge.entries)} entries, ${String(bridge.compared)} compared byte for byte with the build they were packaged from`,
    );
  } catch (error) {
    structuralErrors.push(error);
  }

  const drifted = [];
  for (const artifact of artifacts) {
    if (await digestOf(artifact.snapshot) !== artifact.digest) {
      throw new Error(`The ${artifact.label} snapshot changed during verification. Nothing was verified.`);
    }
    if (await digestOf(artifact.source) !== artifact.digest) {
      drifted.push(`${artifact.label} at ${artifact.source}`);
    }
  }
  if (drifted.length > 0) {
    throw new Error(
      `Verification ran against an immutable snapshot, but the staged artifact changed while it ran: ${drifted.join(", ")}. Nothing was verified.`,
    );
  }

  if (metadata.status !== 0 || structuralErrors.length > 0) {
    if (metadata.status !== 0) {
      console.error(
        `Release records are incomplete for ${artifacts[0].digest}. Both artifacts are unchanged; nothing was published.`,
      );
    }
    structuralErrors.forEach((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
    process.exitCode = 1;
    return;
  }

  console.log(
    `Verified this exact release set: applicable release checks, binding, and packaged bytes all describe\n  Bachata VSIX ${artifacts[0].digest}\n  Browser Bridge ZIP ${artifacts[1].digest}`,
  );
};

// Every temporary directory this command or anything it calls creates — the artifact
// snapshot here and the VSIX extraction inside verifyVsix — is tracked in one registry,
// so a signal cannot re-raise while another stage still owns a directory on disk.
const cleanup = () => {
  const failures = removeEveryTrackedTemporaryDirectory();
  failures.forEach((failure) => {
    console.error(`Could not remove the temporary directory ${failure}`);
  });
  return failures.length === 0;
};

const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const handlers = {};
signals.forEach((signal) => {
  handlers[signal] = () => {
    if (!cleanup() && !cleanup()) {
      console.error(
        `Refusing to exit on ${signal} until ${trackedTemporaryDirectories().join(", ")} is removed. Remove it by hand.`,
      );
      process.exitCode = 1;
      return;
    }
    signals.forEach((name) => process.off(name, handlers[name]));
    process.kill(process.pid, signal);
  };
  process.on(signal, handlers[signal]);
});
process.on("exit", () => {
  cleanup();
});

try {
  await verify();
} finally {
  signals.forEach((signal) => process.off(signal, handlers[signal]));
  if (!cleanup()) {
    process.exitCode = 1;
  }
}
