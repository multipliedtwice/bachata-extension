import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fileBytes = async (file) => {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) {
    throw new Error(`Not a bounded regular release file: ${path.basename(file)}`);
  }
  return readFile(file);
};

export const requireShipVerdict = (document) => {
  const section = /^## Verdict\s*\n([\s\S]*?)(?=\n## |$)/mu.exec(document)?.[1]?.trim();
  if (!section || !/^\*\*SHIP(?:[ .:]|\*\*)/u.test(section)) {
    throw new Error("Publication requires the human SHIP verdict in docs/RELEASE_VERDICT.md.");
  }
};

export const verifyReleaseBundle = async (directory, expected) => {
  const manifest = JSON.parse(await fileBytes(path.join(directory, "release-set.json")));
  if (manifest.schemaVersion !== 1 || manifest.repository !== expected.repository
    || manifest.commit !== expected.commit || manifest.runId !== expected.runId
    || manifest.runAttempt !== expected.runAttempt) {
    throw new Error("Release bundle provenance does not match the verified workflow attempt.");
  }
  const result = {};
  const names = ["release-set.json", "RELEASE_VERDICT.md"];
  for (const kind of ["vscode", "bridge"]) {
    const record = manifest[kind];
    const prefix = kind === "vscode" ? "bachata-vscode" : "bachata-browser-bridge";
    const suffix = kind === "vscode" ? "vsix" : "zip";
    if (!record || !/^\d+\.\d+\.\d+$/u.test(record.version)
      || record.file !== `${prefix}-${record.version}.${suffix}`
      || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
      throw new Error(`Invalid ${kind} artifact identity.`);
    }
    const bytes = await fileBytes(path.join(directory, record.file));
    if (sha256(bytes) !== record.sha256) throw new Error(`${kind} artifact digest mismatch.`);
    names.push(record.file);
    result[kind] = { ...record, bytes, path: path.join(directory, record.file) };
  }
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(names.sort())) {
    throw new Error("Release bundle contains missing or unexpected files.");
  }
  const verdict = await fileBytes(path.join(directory, "RELEASE_VERDICT.md"));
  if (sha256(verdict) !== manifest.verdictSha256) throw new Error("Release verdict digest mismatch.");
  requireShipVerdict(verdict.toString("utf8"));
  return result;
};

const createBundle = async (directory, env) => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const compatibility = JSON.parse(await readFile(path.join(root, "protocol/browser-bridge.compatibility.json"), "utf8"));
  const verdict = await fileBytes(path.join(root, "docs/RELEASE_VERDICT.md"));
  requireShipVerdict(verdict.toString("utf8"));
  const manifest = {
    schemaVersion: 1,
    repository: env.GITHUB_REPOSITORY,
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    verdictSha256: sha256(verdict),
  };
  if (!/^[a-f0-9]{40}$/u.test(manifest.commit ?? "")
    || !/^[\w.-]+\/[\w.-]+$/u.test(manifest.repository ?? "")
    || !/^\d+$/u.test(manifest.runId ?? "") || !/^\d+$/u.test(manifest.runAttempt ?? "")) {
    throw new Error("A release bundle must name its GitHub workflow attempt and source commit.");
  }
  const records = [
    ["vscode", pkg.version, `bachata-vscode-${pkg.version}.vsix`, root],
    ["bridge", compatibility.browserBridgeVersion,
      `bachata-browser-bridge-${compatibility.browserBridgeVersion}.zip`, path.dirname(root)],
  ];
  await mkdir(directory);
  for (const [kind, version, file, source] of records) {
    const bytes = await fileBytes(path.join(source, file));
    manifest[kind] = { file, version, sha256: sha256(bytes) };
    await writeFile(path.join(directory, file), bytes, { flag: "wx" });
  }
  await writeFile(path.join(directory, "RELEASE_VERDICT.md"), verdict, { flag: "wx" });
  await writeFile(path.join(directory, "release-set.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await verifyReleaseBundle(directory, manifest);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory] = process.argv.slice(2);
  if (!directory || !["create", "verify"].includes(command)) throw new Error("Usage: release-bundle.mjs create|verify DIRECTORY");
  if (command === "create") await createBundle(path.resolve(directory), process.env);
  else await verifyReleaseBundle(path.resolve(directory), {
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.GITHUB_SHA,
    runId: process.env.RELEASE_RUN_ID,
    runAttempt: process.env.RELEASE_RUN_ATTEMPT,
  });
}
