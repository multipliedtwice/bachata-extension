const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// EX-UI-03. A control byte in maintained source is never intended: a NUL written into a template
// literal made `file` call the module data and `git diff` refuse to show it as text. Tab, newline
// and carriage return are the only bytes below 0x20 a source file may carry; everything else in
// that range, and DEL, is refused by name and offset so the fix is a one-line edit.
//
// The rule used to be read over `src/` alone, and the byte it exists to catch was sitting in
// `tests/assetNaming.test.cjs` the whole time — two literal NULs and two literal DELs, in the very
// test that asserts those characters are replaced. A gate that reads a quarter of the maintained
// tree reports the other three quarters as clean without looking at them, so every tree whose
// bytes are hand-written is read: the shipped sources, the tests that check them, the scripts that
// gate them and the end-to-end entry points.
//
// What is left out is left out by name and for a stated reason, never by an extension nobody
// thought of. `dist/`, `node_modules/` and `media/` are not maintained source — build output,
// third-party bytes and binary assets — and none of them is under a root read here. Inside these
// roots, TEXT_EXTENSIONS names every kind of file whose bytes a person writes, and EXCLUDED names
// any individual path exempted from the rule. EXCLUDED is empty: every file under these roots is
// hand-written text, and an entry added later has to name a path that exists.
const repository = path.join(__dirname, "..");
const ROOTS = ["src", "tests", "scripts", "e2e"];
const TEXT_EXTENSIONS = new Set([".ts", ".css", ".json", ".md", ".html", ".js", ".mjs", ".cjs", ".ps1"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);
const EXCLUDED = [];

const allowed = new Set([0x09, 0x0a, 0x0d]);

const walk = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : walk(absolute);
    if (!entry.isFile()) return [];
    return TEXT_EXTENSIONS.has(path.extname(entry.name)) ? [absolute] : [];
  });

const maintainedSource = () =>
  ROOTS.flatMap((relative) => walk(path.join(repository, relative)))
    .map((absolute) => path.relative(repository, absolute))
    .filter((relative) => !EXCLUDED.includes(relative))
    .sort();

const controlBytesIn = (bytes) => {
  const found = [];
  let line = 1;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if ((byte < 0x20 && !allowed.has(byte)) || byte === 0x7f) {
      found.push({ offset: index, line, byte: `0x${byte.toString(16).padStart(2, "0")}` });
    }
    if (byte === 0x0a) line += 1;
  }
  return found;
};

test("maintained source carries no control bytes beyond tab, newline and carriage return", () => {
  const offenders = maintainedSource().flatMap((relative) => {
    const found = controlBytesIn(fs.readFileSync(path.join(repository, relative)));
    return found.length === 0 ? [] : [{ file: relative, found }];
  });
  assert.deepEqual(offenders, []);
});

// A walk that returns nothing satisfies the rule above by reading nothing at all, which is exactly
// how the previous version of this gate passed over the file carrying the byte. So the enumeration
// is asserted before it is trusted: every root contributes, and the files that most recently
// mattered — the one that carried the NULs, this one, the browser gate and its extracted session —
// are named rather than assumed present.
test("the enumeration actually covers every maintained tree", () => {
  const files = maintainedSource();
  for (const root of ROOTS) {
    assert.ok(
      files.some((relative) => relative.startsWith(`${root}${path.sep}`)),
      `${root}/ contributed no files, so the byte rule never read it`,
    );
  }
  for (const named of [
    path.join("tests", "assetNaming.test.cjs"),
    path.join("tests", "sourceBytes.test.cjs"),
    path.join("scripts", "run-webview-layout.mjs"),
    path.join("scripts", "lib", "chromeSession.mjs"),
    path.join("e2e", "suite", "index.cjs"),
  ]) {
    assert.ok(files.includes(named), `${named} is maintained source and was not enumerated`);
  }
  assert.ok(files.length > 300, `only ${String(files.length)} maintained files were enumerated`);
});

// An exemption naming a path that no longer exists is an exemption nobody is reading. It is also
// how a rule quietly stops applying to a file that was moved back under it.
test("every byte-rule exemption names a file that exists", () => {
  for (const relative of EXCLUDED) {
    assert.ok(fs.existsSync(path.join(repository, relative)), `${relative} is exempted and absent`);
  }
});

// A tracked test file with no bytes in it runs no assertions and still counts as a test file, which
// is what `tests/pipelineResources.test.cjs` did: committed empty "to ensure future coverage", and
// counted as one more passing file for as long as it stayed that way.
test("no maintained test file is empty", () => {
  const empty = maintainedSource()
    .filter((relative) => relative.endsWith(".test.cjs"))
    .filter((relative) => fs.statSync(path.join(repository, relative)).size === 0);
  assert.deepEqual(empty, []);
});

test("the byte rule itself accepts tab, newline and carriage return and refuses NUL and DEL", () => {
  assert.deepEqual(controlBytesIn(Buffer.from("a\tb\nc\r\n", "utf8")), []);
  assert.deepEqual(controlBytesIn(Buffer.from("x\u0000y", "utf8")), [{ offset: 1, line: 1, byte: "0x00" }]);
  assert.deepEqual(controlBytesIn(Buffer.from("line\n\u007f", "utf8")), [{ offset: 5, line: 2, byte: "0x7f" }]);
  assert.deepEqual(controlBytesIn(Buffer.from("é✓", "utf8")), []);
});
