// EX-AUD-06. Every timeout setting must be read through `readTimeoutSetting`, which clamps
// the value to a delay `setTimeout` can actually hold. A raw read hands whatever is in a
// hand-edited `settings.json` straight to a timer, and a value above 2_147_483_647 does not
// throw — it silently becomes a 1 ms timer.
//
// This is an AST walk, not a grep, because the reads do not share a syntactic shape. The one
// this replaces matched `.get<number>(` and therefore missed `configuration.get("...", n)`
// in `src/commands/doctor.ts`, which had no type argument. A pattern narrow enough to be
// written by hand is narrow enough to miss the next one.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");

export const TIMEOUT_SETTING_SUFFIXES = ["TimeoutMs", "GraceMs"];
export const SHARED_TIMEOUT_READER = "readTimeoutSetting";

const isTimeoutSettingKey = (value) =>
  TIMEOUT_SETTING_SUFFIXES.some((suffix) => value.endsWith(suffix));

const typeScriptFiles = async (directory) => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await typeScriptFiles(absolute)));
      continue;
    }
    if (entry.isFile() && /\.ts$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name)) {
      found.push(absolute);
    }
  }
  return found;
};

// A read counts as guarded when some ancestor call is `readTimeoutSetting(...)`. The reader
// takes the raw accessor as a callback, so the `.get` call is nested inside it.
const enclosedBySharedReader = (node) => {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (
      ts.isCallExpression(cursor)
      && ts.isIdentifier(cursor.expression)
      && cursor.expression.text === SHARED_TIMEOUT_READER
    ) {
      return true;
    }
  }
  return false;
};

export const findUnguardedTimeoutReads = async (directory = sourceRoot) => {
  const findings = [];
  for (const file of await typeScriptFiles(directory)) {
    const text = await readFile(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "get"
        && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])
        && isTimeoutSettingKey(node.arguments[0].text)
        && !enclosedBySharedReader(node)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({
          file: path.relative(root, file),
          line: line + 1,
          key: node.arguments[0].text,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings.sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file));
};

// Counted from the reader's own call sites, not from `.get`. A wrapped read passes the
// setting key to `readTimeoutSetting` and an identifier to `.get`, so counting `.get` calls
// with a literal key would report zero however many reads were correctly routed.
export const findGuardedTimeoutReads = async (directory = sourceRoot) => {
  const found = [];
  for (const file of await typeScriptFiles(directory)) {
    const text = await readFile(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === SHARED_TIMEOUT_READER
        && node.arguments.length >= 2
        && ts.isStringLiteralLike(node.arguments[1])
        && isTimeoutSettingKey(node.arguments[1].text)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({
          file: path.relative(root, file),
          line: line + 1,
          key: node.arguments[1].text,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found.sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file));
};

const main = async () => {
  const findings = await findUnguardedTimeoutReads();
  const guarded = await findGuardedTimeoutReads();
  if (findings.length > 0) {
    console.error(
      `${String(findings.length)} timeout setting read(s) bypass ${SHARED_TIMEOUT_READER}:`,
    );
    for (const finding of findings) {
      console.error(`- ${finding.file}:${String(finding.line)}: ${finding.key}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `All ${String(guarded.length)} timeout setting reads go through ${SHARED_TIMEOUT_READER}.`,
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
