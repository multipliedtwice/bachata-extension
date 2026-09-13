import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith(".ts") ? [file] : [];
  }));
  return files.flat().sort();
};

export const placeholders = (message) =>
  [...new Set(Array.from(message.matchAll(/\{(\d+)\}/gu), (match) => match[1]))].sort();

export const extractMessages = async (directory) => {
  const messages = new Set();
  const errors = [];
  for (const file of await sourceFiles(directory)) {
    const text = await readFile(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ["localize", "vscode.l10n.t"].includes(node.expression.getText(source))) {
        const message = node.arguments[0];
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (!message || !(ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message))) {
          errors.push(`${path.relative(root, file)}:${line}: localization requires a literal message`);
        } else {
          messages.add(message.text);
          if (placeholders(message.text).some((index) => Number(index) >= node.arguments.length - 1)) {
            errors.push(`${path.relative(root, file)}:${line}: missing placeholder argument`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return Object.fromEntries([...messages].sort().map((message) => [message, message]));
};

const readCatalog = async (file) => {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: expected a message object`);
  return value;
};

export const validateCatalog = (catalog, english, name) => {
  const errors = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (!Object.hasOwn(english, key)) errors.push(`${name}: unknown message ${key}`);
    else if (typeof value !== "string" || value.trim() === "") errors.push(`${name}: empty or non-string message ${key}`);
    else if (JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(english[key]))) errors.push(`${name}: placeholder mismatch in ${key}`);
  }
  return errors;
};

const validateManifest = (manifest, english) => {
  const keys = new Set();
  const visit = (value) => {
    if (typeof value === "string" && /^%[^%]+%$/u.test(value)) keys.add(value.slice(1, -1));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(manifest);
  return [
    ...[...keys].filter((key) => !Object.hasOwn(english, key)).map((key) => `package.nls.json: missing ${key}`),
    ...Object.keys(english).filter((key) => !keys.has(key)).map((key) => `package.nls.json: unused ${key}`),
  ];
};

const main = async () => {
  const command = process.argv[2] ?? "check";
  if (!["extract", "check"].includes(command)) throw new Error("Use localization.mjs extract or localization.mjs check");
  const extracted = await extractMessages(path.join(root, "src"));
  const bundleFile = path.join(root, "l10n", "bundle.l10n.json");
  if (command === "extract") {
    await mkdir(path.dirname(bundleFile), { recursive: true });
    await writeFile(bundleFile, `${JSON.stringify(extracted, null, 2)}\n`);
  }
  const english = await readCatalog(bundleFile);
  const manifestEnglish = await readCatalog(path.join(root, "package.nls.json"));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const errors = validateManifest(manifest, manifestEnglish);
  if (JSON.stringify(english) !== JSON.stringify(extracted)) errors.push("English runtime catalog is stale; run npm run l10n:extract");
  errors.push(...validateCatalog(english, extracted, "bundle.l10n.json"));
  for (const name of await readdir(path.join(root, "l10n"))) {
    if (!/^bundle\.l10n\.[^.]+\.json$/u.test(name)) continue;
    errors.push(...validateCatalog(await readCatalog(path.join(root, "l10n", name)), english, name));
  }
  for (const name of await readdir(root)) {
    if (!/^package\.nls\.[^.]+\.json$/u.test(name)) continue;
    errors.push(...validateCatalog(await readCatalog(path.join(root, name)), manifestEnglish, name));
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  process.stdout.write(`Localization catalogs valid: ${Object.keys(english).length} runtime messages, ${Object.keys(manifestEnglish).length} manifest messages.\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
