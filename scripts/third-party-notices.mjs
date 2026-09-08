import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { byCodeUnit } from "./lib/ordinal.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageRoot = (name) => path.join(root, "node_modules", ...name.split("/"));

const licenseFiles = async (directory) => {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(directory))
    .filter((name) => /^(?:license|notice)(?:[-._].*)?$/iu.test(name))
    .sort(byCodeUnit);
};

const dependencyClosure = async (roots) => {
  const pending = [...roots];
  const packages = new Map();
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || packages.has(name)) continue;
    const directory = packageRoot(name);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    packages.set(name, { directory, manifest });
    pending.push(...Object.keys(manifest.dependencies ?? {}));
  }
  return [...packages.entries()].sort(([left], [right]) => byCodeUnit(left, right));
};

export const generateThirdPartyNotices = async ({ roots, output }) => {
  const sections = [];
  for (const [name, value] of await dependencyClosure(roots)) {
    const files = await licenseFiles(value.directory);
    if (files.length === 0) throw new Error(`No license file found for ${name}`);
    const repository = typeof value.manifest.repository === "string"
      ? value.manifest.repository
      : value.manifest.repository?.url;
    const header = [
      `${name}@${String(value.manifest.version)}`,
      `License: ${String(value.manifest.license ?? "see included text")}`,
      repository ? `Source: ${repository}` : undefined,
    ].filter(Boolean).join("\n");
    const texts = await Promise.all(files.map(async (file) =>
      `--- ${file} ---\n${(await readFile(path.join(value.directory, file), "utf8")).trim()}`));
    sections.push(`${header}\n\n${texts.join("\n\n")}`);
  }
  const content = [
    "Bachata third-party notices",
    "",
    "The following components are redistributed with this package.",
    "",
    sections.join("\n\n============================================================\n\n"),
    "",
  ].join("\n");
  await writeFile(output, content, "utf8");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateThirdPartyNotices({
    roots: ["ajv", "fast-glob", "ignore", "jsonrepair", "ts-morph", "typescript", "prismjs", "@vscode/codicons"],
    output: path.join(root, "dist", "THIRD_PARTY_NOTICES.txt"),
  });
}
