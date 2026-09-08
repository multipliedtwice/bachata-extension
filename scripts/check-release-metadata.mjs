import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { releaseMetadataFindings } from "./lib/releaseMetadata.mjs";
import {
  BRIDGE_ARTIFACT_LIMITS,
  VSIX_ARTIFACT_LIMITS,
  readArtifactSnapshot,
  resolvePinnedBridgeArchive,
} from "./lib/releaseArtifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STAGES = new Set(["identity", "evidence", "artifact", "all"]);
const stageArgument = process.argv.slice(2).find((value) => value.startsWith("--stage="));
const stage = stageArgument ? stageArgument.slice("--stage=".length) : "all";
if (!STAGES.has(stage)) {
  throw new Error(
    `Unknown release metadata stage: ${stage}. Use ${[...STAGES].join(", ")}.`,
  );
}
const bindsArtifacts = stage === "artifact" || stage === "all";
const pathArgument = (name) => {
  const entry = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return entry ? entry.slice(`--${name}=`.length) : undefined;
};
const vsixOverride = pathArgument("vsix");
const bridgeOverride = pathArgument("bridge");

const readOptional = async (relative) => {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch {
    return undefined;
  }
};

const listScreenshots = async () => {
  try {
    const entries = await readdir(path.join(root, "media", "screenshots"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(?:png|jpg|jpeg|gif|webp)$/iu.test(entry.name))
      .map((entry) => `media/screenshots/${entry.name}`);
  } catch {
    return [];
  }
};

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const pinnedBridge = bindsArtifacts ? await resolvePinnedBridgeArchive(root) : undefined;
if (vsixOverride && path.basename(vsixOverride) !== `bachata-vscode-${packageJson.version}.vsix`) {
  throw new Error(
    `--vsix=${vsixOverride} is not named bachata-vscode-${packageJson.version}.vsix, so it is not this release's candidate`,
  );
}
if (bridgeOverride && pinnedBridge && path.basename(bridgeOverride) !== pinnedBridge.fileName) {
  throw new Error(
    `--bridge=${bridgeOverride} is not named ${pinnedBridge.fileName}, so it is not the pinned Browser Bridge archive`,
  );
}

const snapshotOrUndefined = async (candidate, entry, label, limits) => {
  try {
    return await readArtifactSnapshot(candidate, entry, label, limits);
  } catch (error) {
    if ((error && error.code) === "ENOENT") return undefined;
    throw error;
  }
};

const vsixSnapshot = !bindsArtifacts
  ? undefined
  : await snapshotOrUndefined(
      vsixOverride ?? path.join(root, `bachata-vscode-${packageJson.version}.vsix`),
      "extension/package.json",
      `bachata-vscode-${packageJson.version}.vsix`,
      VSIX_ARTIFACT_LIMITS,
    );
const bridgeSnapshot = !bindsArtifacts
  ? undefined
  : bridgeOverride
    ? await snapshotOrUndefined(
        bridgeOverride,
        "manifest.json",
        pinnedBridge.fileName,
        BRIDGE_ARTIFACT_LIMITS,
      )
    : pinnedBridge;
if (bridgeOverride && bridgeSnapshot && bridgeSnapshot.version !== pinnedBridge.version) {
  throw new Error(
    `--bridge=${bridgeOverride} declares version ${bridgeSnapshot.version}, but this release pins ${pinnedBridge.version}`,
  );
}

const artifacts = !bindsArtifacts ? {} : {
  ...(vsixSnapshot
    ? { vsix: { version: vsixSnapshot.version, sha256: vsixSnapshot.sha256, path: vsixSnapshot.path } }
    : {}),
  ...(bridgeSnapshot
    ? { bridge: { version: bridgeSnapshot.version, sha256: bridgeSnapshot.sha256, path: bridgeSnapshot.path } }
    : {}),
};

const findings = releaseMetadataFindings({
  packageJson,
  readme: (await readOptional("README.md")) ?? "",
  screenshotFiles: await listScreenshots(),
  bridgeInstallDocument: await readOptional("docs/BROWSER_BRIDGE_INSTALL.md"),
  validationRecord: await readOptional("docs/RELEASE_VALIDATION_RECORD.md"),
  providerTerms: await readOptional("docs/PROVIDER_TERMS.md"),
  compatibilityMatrix: await readOptional("docs/COMPATIBILITY_MATRIX.md"),
  providerDocumentationSource: (await readOptional("src/readiness/providerDocs.ts")) ?? "",
  artifacts,
  stage,
});

if (bindsArtifacts) {
  if (!artifacts.vsix) {
    findings.unshift(`No staged VSIX bachata-vscode-${packageJson.version}.vsix was found; release records cannot be bound to an artifact.`);
  }
  if (!artifacts.bridge) {
    findings.unshift("The pinned Browser Bridge ZIP was not found; Bridge records cannot be bound to an artifact.");
  }
}

if (findings.length > 0) {
  console.error(
    `Public distribution metadata is not release ready (${stage} stage):\n- ${findings.join("\n- ")}`,
  );
  process.exit(1);
}
console.log(`Public distribution metadata is complete (${stage} stage).`);
