const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const skippedDirectories = new Set(["node_modules", "dist", ".git", ".vscode-test", "coverage"]);
const scannedExtensions = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs", ".json", ".md", ".html", ".css"]);

const scannedFiles = (directory = root) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) ? [] : scannedFiles(path.join(directory, entry.name));
    }
    const file = path.join(directory, entry.name);
    return scannedExtensions.has(path.extname(entry.name)) ? [file] : [];
  });

test("the retired mixed-case product name is absent", () => {
  const retiredName = `p${"AI"}r`;
  const offenders = scannedFiles()
    .map((file) => path.relative(root, file))
    .filter((file) => fs.readFileSync(path.join(root, file), "utf8").includes(retiredName));
  assert.deepEqual(offenders, []);
});

test("package metadata uses the canonical display name and command title prefix", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.displayName, "Bachata");
  assert.equal(packageJson.name, "bachata-vscode");
  const commands = packageJson.contributes.commands;
  assert.ok(commands.length > 0);
  assert.deepEqual(
    commands.filter((command) => command.category !== "Bachata").map((command) => command.command),
    [],
    "a command is contributed outside the Bachata category",
  );
  assert.deepEqual(
    commands.filter((command) => /Bachata/u.test(command.title)).map((command) => command.command),
    [],
    "a command title repeats the name the category already supplies",
  );
  // The palette renders "<category>: <title>", so this is the string the user reads.
  const palette = commands.map((command) => `${command.category}: ${command.title}`);
  assert.deepEqual(
    palette.filter((entry) => !/^Bachata: \S/u.test(entry)),
    [],
    "a command does not present in the Command Palette as \"Bachata: <Action>\"",
  );
  const identifiers = packageJson.contributes.commands.map((command) => command.command);
  assert.deepEqual(identifiers.filter((identifier) => !identifier.startsWith("bachata.")), []);
});

test("the branding rules are documented", () => {
  const branding = fs.readFileSync(path.join(root, "docs", "BRANDING.md"), "utf8");
  for (const marker of [
    "Human-directed agentic pipelines for software refinement.",
    "BACHATA_",
    "Bachata: <Action>",
    "Keep ordinary English `pair`, `paired`, and `pairing` unchanged.",
  ]) {
    assert.equal(branding.includes(marker), true, `Missing branding rule: ${marker}`);
  }
});
