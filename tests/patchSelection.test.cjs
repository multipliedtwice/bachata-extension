const assert = require("node:assert/strict");
const test = require("node:test");

const {
  boundPatchFiles,
  parsePatchFiles,
  parsePatchHunkReferences,
  selectPatch,
  selectionIsEmpty,
  PATCH_FILE_LIMIT,
  PATCH_HUNK_LIMIT,
} = require("../dist/orchestrator/patchSelection.js");

const textPatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " first",
  "-old top",
  "+new top",
  " third",
  "@@ -30,3 +30,3 @@",
  " before",
  "-old bottom",
  "+new bottom",
  " after",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 3333333..4444444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-b old",
  "+b new",
  "",
].join("\n");

const binaryPatch = [
  "diff --git a/logo.png b/logo.png",
  "index 5555555..6666666 100644",
  "GIT binary patch",
  "literal 6",
  "zcmZQzU|;|--",
  "",
].join("\n");

const renamePatch = [
  "diff --git a/old.ts b/new.ts",
  "similarity index 92%",
  "rename from old.ts",
  "rename to new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

test("a text diff is split into files and hunks", () => {
  const files = parsePatchFiles(textPatch);
  assert.deepEqual(files.map((file) => file.path), ["src/a.ts", "src/b.ts"]);
  assert.equal(files[0].hunks.length, 2);
  assert.equal(files[0].wholeFileOnly, false);
  assert.equal(files[0].hunks[0].header, "@@ -1,3 +1,3 @@");
  assert.equal(files[0].hunks[0].added, 1);
  assert.equal(files[0].hunks[0].removed, 1);
  assert.match(files[0].hunks[1].preview, /new bottom/u);
  assert.equal(files[1].hunks.length, 1);
});

test("binary and renamed files are whole-file only", () => {
  const binary = parsePatchFiles(binaryPatch)[0];
  assert.equal(binary.path, "logo.png");
  assert.equal(binary.binary, true);
  assert.equal(binary.wholeFileOnly, true);
  assert.deepEqual(binary.hunks, []);

  const renamed = parsePatchFiles(renamePatch)[0];
  assert.equal(renamed.path, "new.ts");
  assert.equal(renamed.oldPath, "old.ts");
  assert.equal(renamed.renamed, true);
  assert.equal(renamed.wholeFileOnly, true);
});

test("an empty selection keeps the whole patch", () => {
  assert.equal(selectionIsEmpty(undefined), true);
  assert.equal(selectionIsEmpty({ paths: [], hunks: [] }), true);
  assert.equal(selectPatch(textPatch, {}).patch, textPatch);
});

test("a hunk selection keeps only the selected hunks of that file", () => {
  const result = selectPatch(textPatch, { hunks: [{ path: "src/a.ts", index: 1 }] });
  assert.equal(result.refusal, undefined);
  assert.match(result.patch, /new bottom/u);
  assert.doesNotMatch(result.patch, /new top/u);
  assert.doesNotMatch(result.patch, /src\/b\.ts/u);
  assert.match(result.patch, /^diff --git a\/src\/a\.ts b\/src\/a\.ts/u);
  assert.match(result.patch, /\+\+\+ b\/src\/a\.ts/u);
});

test("a file selection and a hunk selection combine without duplicating the file", () => {
  const result = selectPatch(textPatch, {
    paths: ["src/b.ts"],
    hunks: [{ path: "src/a.ts", index: 0 }],
  });
  assert.equal(result.refusal, undefined);
  assert.equal(result.patch.match(/diff --git/gu).length, 2);
  assert.match(result.patch, /new top/u);
  assert.doesNotMatch(result.patch, /new bottom/u);
  assert.match(result.patch, /b new/u);
});

test("selecting a whole file keeps every hunk of that file", () => {
  const result = selectPatch(textPatch, {
    paths: ["src/a.ts"],
    hunks: [{ path: "src/a.ts", index: 0 }],
  });
  assert.equal(result.patch.match(/diff --git/gu).length, 1);
  assert.match(result.patch, /new top/u);
  assert.match(result.patch, /new bottom/u);
});

test("a selection outside the authoritative diff is refused", () => {
  assert.match(
    selectPatch(textPatch, { paths: ["src/never.ts"] }).refusal,
    /refuses to apply paths this run did not change/u,
  );
  assert.match(
    selectPatch(textPatch, { hunks: [{ path: "src/never.ts", index: 0 }] }).refusal,
    /refuses to apply paths this run did not change/u,
  );
  assert.match(
    selectPatch(textPatch, { hunks: [{ path: "src/a.ts", index: 7 }] }).refusal,
    /not part of this run's diff/u,
  );
  assert.equal(selectPatch(textPatch, { paths: ["src/never.ts"] }).patch, "");
});

test("part of a binary or renamed file is refused, the whole file is allowed", () => {
  assert.match(
    selectPatch(binaryPatch, { hunks: [{ path: "logo.png", index: 0 }] }).refusal,
    /part of a binary or renamed file/u,
  );
  assert.match(
    selectPatch(renamePatch, { hunks: [{ path: "new.ts", index: 0 }] }).refusal,
    /part of a binary or renamed file/u,
  );
  const whole = selectPatch(`${binaryPatch}${renamePatch}`, { paths: ["logo.png"] });
  assert.equal(whole.refusal, undefined);
  assert.match(whole.patch, /GIT binary patch/u);
  assert.doesNotMatch(whole.patch, /rename from/u);
});

test("hunk references are parsed defensively", () => {
  assert.deepEqual(
    parsePatchHunkReferences([
      { path: "src/a.ts", index: 0 },
      { path: "src/a.ts", index: -1 },
      { path: "src/a.ts", index: 1.5 },
      { path: 7, index: 0 },
      "src/a.ts#0",
      null,
    ]),
    [{ path: "src/a.ts", index: 0 }],
  );
  assert.deepEqual(parsePatchHunkReferences(undefined), []);
});

const pureRenameWithSpaces = [
  "diff --git a/old name.txt b/new name.txt",
  "similarity index 100%",
  "rename from old name.txt",
  "rename to new name.txt",
  "",
].join("\n");

const quotedRename = [
  'diff --git "a/tab\\tfile.txt" "b/renamed\\ttab.txt"',
  "similarity index 100%",
  'rename from "tab\\tfile.txt"',
  'rename to "renamed\\ttab.txt"',
  "",
].join("\n");

const unicodeRename = [
  "diff --git a/ünïcode.txt b/ünïcode-2.txt",
  "similarity index 100%",
  "rename from ünïcode.txt",
  "rename to ünïcode-2.txt",
  "",
].join("\n");

const copyWithSpaces = [
  "diff --git a/source file.txt b/copied file.txt",
  "similarity index 100%",
  "copy from source file.txt",
  "copy to copied file.txt",
  "",
].join("\n");

const spacedEdit = [
  "diff --git a/my dir/my file.ts b/my dir/my file.ts",
  "index 1111111..2222222 100644",
  "--- a/my dir/my file.ts",
  "+++ b/my dir/my file.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const spacedModeOnly = [
  "diff --git a/my dir/run script.sh b/my dir/run script.sh",
  "old mode 100644",
  "new mode 100755",
  "",
].join("\n");

const spacedBinary = [
  "diff --git a/my dir/logo copy.png b/my dir/logo copy.png",
  "index 5555555..6666666 100644",
  "GIT binary patch",
  "literal 4",
  "",
].join("\n");

test("a pure rename with spaces resolves both paths and stays whole-file only", () => {
  const file = parsePatchFiles(pureRenameWithSpaces)[0];
  assert.equal(file.path, "new name.txt");
  assert.equal(file.oldPath, "old name.txt");
  assert.equal(file.renamed, true);
  assert.equal(file.wholeFileOnly, true);
  const selected = selectPatch(pureRenameWithSpaces, { paths: ["new name.txt"] });
  assert.equal(selected.refusal, undefined);
  assert.match(selected.patch, /rename to new name\.txt/u);
});

test("a quoted rename with a tab resolves through the rename markers", () => {
  const file = parsePatchFiles(quotedRename)[0];
  assert.equal(file.path, "renamed\ttab.txt");
  assert.equal(file.oldPath, "tab\tfile.txt");
  assert.equal(file.renamed, true);
  assert.equal(file.wholeFileOnly, true);
  assert.equal(selectPatch(quotedRename, { paths: ["renamed\ttab.txt"] }).refusal, undefined);
});

test("a unicode rename keeps its path", () => {
  const file = parsePatchFiles(unicodeRename)[0];
  assert.equal(file.path, "ünïcode-2.txt");
  assert.equal(file.oldPath, "ünïcode.txt");
  assert.equal(file.wholeFileOnly, true);
});

test("a copy is whole-file only and names the copied path", () => {
  const file = parsePatchFiles(copyWithSpaces)[0];
  assert.equal(file.path, "copied file.txt");
  assert.equal(file.oldPath, "source file.txt");
  assert.equal(file.renamed, true);
  assert.equal(file.wholeFileOnly, true);
  assert.match(
    selectPatch(copyWithSpaces, { hunks: [{ path: "copied file.txt", index: 0 }] }).refusal,
    /part of a binary or renamed file/u,
  );
});

test("edits, mode changes, and binaries with spaces in the path resolve", () => {
  const edited = parsePatchFiles(spacedEdit)[0];
  assert.equal(edited.path, "my dir/my file.ts");
  assert.equal(edited.wholeFileOnly, false);
  assert.equal(edited.hunks.length, 1);
  assert.equal(
    selectPatch(spacedEdit, { hunks: [{ path: "my dir/my file.ts", index: 0 }] }).refusal,
    undefined,
  );

  const modeOnly = parsePatchFiles(spacedModeOnly)[0];
  assert.equal(modeOnly.path, "my dir/run script.sh");
  assert.equal(modeOnly.wholeFileOnly, true);

  const binary = parsePatchFiles(spacedBinary)[0];
  assert.equal(binary.path, "my dir/logo copy.png");
  assert.equal(binary.binary, true);
  assert.equal(binary.wholeFileOnly, true);
});

test("an unresolvable header is whole-file only and never silently mis-selects", () => {
  const broken = parsePatchFiles("diff --git nonsense\n@@ -1 +1 @@\n-a\n+b\n")[0];
  assert.equal(broken.path, "");
  assert.equal(broken.wholeFileOnly, true);
});

test("the hunk inventory is bounded and states what it omitted", () => {
  const hunk = (index) => ({
    index,
    header: `@@ -${String(index)} +${String(index)} @@`,
    added: 1,
    removed: 1,
    preview: `${"x".repeat(900)}\n+short`,
  });
  const file = (name, hunkCount) => ({
    path: name,
    binary: false,
    renamed: false,
    wholeFileOnly: false,
    hunks: Array.from({ length: hunkCount }, (_value, index) => hunk(index)),
  });

  const small = boundPatchFiles([file("a.ts", 2)]);
  assert.equal(small.truncated, undefined);
  assert.equal(small.files[0].hunks[0].preview.split("\n")[0].length, 401);

  const big = boundPatchFiles([
    ...Array.from({ length: PATCH_FILE_LIMIT + 3 }, (_value, index) => file(`f${String(index)}.ts`, 1)),
  ]);
  assert.equal(big.files.length, PATCH_FILE_LIMIT);
  assert.match(big.truncated, /3 more changed files/u);

  const deep = boundPatchFiles([file("deep.ts", PATCH_HUNK_LIMIT + 5)]);
  assert.equal(deep.files[0].hunks.length, PATCH_HUNK_LIMIT);
  assert.match(deep.truncated, /5 more hunks/u);
});

const modeAndContent = [
  "diff --git a/s.sh b/s.sh",
  "old mode 100644",
  "new mode 100755",
  "index 4cb29ea..18e24a3",
  "--- a/s.sh",
  "+++ b/s.sh",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+CHANGED",
  " three",
  "",
].join("\n");

test("a file whose permissions also change is whole-file only", () => {
  const file = parsePatchFiles(modeAndContent)[0];
  assert.equal(file.path, "s.sh");
  assert.equal(file.modeChanged, true);
  assert.equal(file.hunks.length, 1);
  assert.equal(
    file.wholeFileOnly,
    true,
    "a content hunk could be selected while the mode change rode along",
  );

  const partial = selectPatch(modeAndContent, { hunks: [{ path: "s.sh", index: 0 }] });
  assert.equal(partial.patch, "");
  assert.match(partial.refusal, /permissions this run also changed/u);

  const whole = selectPatch(modeAndContent, { paths: ["s.sh"] });
  assert.equal(whole.refusal, undefined);
  assert.match(whole.patch, /new mode 100755/u);
  assert.match(whole.patch, /\+CHANGED/u);
});

test("new and deleted files are whole-file only", () => {
  const added = parsePatchFiles([
    "diff --git a/fresh.ts b/fresh.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/fresh.ts",
    "@@ -0,0 +1 @@",
    "+added",
    "",
  ].join("\n"))[0];
  assert.equal(added.path, "fresh.ts");
  assert.equal(added.modeChanged, true);
  assert.equal(added.wholeFileOnly, true);

  const removed = parsePatchFiles([
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "",
  ].join("\n"))[0];
  assert.equal(removed.path, "gone.ts");
  assert.equal(removed.wholeFileOnly, true);
});
