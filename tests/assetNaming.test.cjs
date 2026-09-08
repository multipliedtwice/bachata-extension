const assert = require("node:assert/strict");
const test = require("node:test");

const { safeBrowserAssetName } = require("../dist/runtime/assetNaming.js");

// EX-3 slice. This was a closure inside an 8,800-line factory and could only be reached
// through the whole runtime. The name it transforms is chosen by a model, so its edge cases
// are worth stating directly.
test("a browser asset name keeps only a safe basename", () => {
  assert.equal(safeBrowserAssetName("report.pdf"), "report.pdf");
  assert.equal(safeBrowserAssetName("notes.md"), "notes.md");
});

test("directory components cannot escape the chosen destination", () => {
  assert.equal(safeBrowserAssetName("../../etc/passwd"), "passwd");
  assert.equal(safeBrowserAssetName("/absolute/path/file.txt"), "file.txt");
  assert.equal(safeBrowserAssetName("nested/dir/report.pdf"), "report.pdf");
  for (const name of ["../../etc/passwd", "/abs/x", "a/b/c"]) {
    const safe = safeBrowserAssetName(name);
    assert.equal(safe.includes("/"), false, `${name} kept a path separator`);
    assert.equal(safe.includes("\\"), false, `${name} kept a path separator`);
  }
});

test("separators, wildcards and control characters are replaced", () => {
  assert.equal(safeBrowserAssetName("name:b*c?d\"e<f>g|h.txt"), "name_b_c_d_e_f_g_h.txt");
  assert.equal(
    safeBrowserAssetName("a:b*c?d\"e<f>g|h.txt"),
    process.platform === "win32" ? "b_c_d_e_f_g_h.txt" : "a_b_c_d_e_f_g_h.txt",
  );
  assert.equal(safeBrowserAssetName("tab\tname.txt").includes("\t"), false);
  assert.equal(safeBrowserAssetName("nul\u0000name.txt").includes("\u0000"), false);
  assert.equal(safeBrowserAssetName("del\u007fname.txt").includes("\u007f"), false);
});

test("a name that would hide the file or empty it falls back", () => {
  assert.equal(safeBrowserAssetName(".hidden"), "hidden");
  assert.equal(safeBrowserAssetName("..."), "browser-asset");
  assert.equal(safeBrowserAssetName(""), "browser-asset");
  assert.equal(safeBrowserAssetName("   "), "browser-asset");
  assert.equal(safeBrowserAssetName("/"), "browser-asset");
});

test("a very long name is bounded", () => {
  const long = safeBrowserAssetName(`${"a".repeat(500)}.txt`);
  assert.equal(long.length, 180);
});

test("compatibility forms are normalized before the name is judged", () => {
  // NFKC folds the fullwidth solidus to "/", which must then be treated as a separator.
  assert.equal(safeBrowserAssetName("a／b.txt").includes("/"), false);
});

// EX-AUD-04 / BB-AUD-04. One table, identical bytes in both repositories, each pinning its
// digest so a rule cannot be relaxed on one side alone.
const SHARED_ASSET_NAME_FIXTURE_SHA256 =
  "a83ffececdd6bb578dc4bd7d40fe2ca2c9029e6bc048fe60e8883c9807dd032c";

const assetNameFixturePath = require("node:path").join(
  __dirname, "..", "protocol", "asset-name.fixtures.json",
);

test("the shared asset-name fixture table cannot drift on one side", () => {
  const bytes = require("node:fs").readFileSync(assetNameFixturePath);
  assert.equal(
    require("node:crypto").createHash("sha256").update(bytes).digest("hex"),
    SHARED_ASSET_NAME_FIXTURE_SHA256,
  );
});

test("every shared asset-name case sanitises to its recorded result", () => {
  const table = JSON.parse(require("node:fs").readFileSync(assetNameFixturePath, "utf8"));
  assert.equal(table.id, "bachata-asset-name-sanitation-v1");
  assert.ok(table.cases.length >= 20);
  for (const testCase of table.cases) {
    assert.equal(
      safeBrowserAssetName(testCase.input),
      testCase.expected,
      `${testCase.name}: ${JSON.stringify(testCase.input)}`,
    );
  }
});

test("a sanitised name never ends in a dot or space and never names a device", () => {
  const table = JSON.parse(require("node:fs").readFileSync(assetNameFixturePath, "utf8"));
  const deviceStem = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
  for (const testCase of table.cases) {
    const result = safeBrowserAssetName(testCase.input);
    assert.equal(/[. ]$/u.test(result), false, `${testCase.name} ended in a dot or space`);
    assert.equal(deviceStem.test(result), false, `${testCase.name} still names a device`);
    assert.ok(result.length > 0, `${testCase.name} produced an empty name`);
  }
});

// EX-AUD-04 follow-up. The device prefix was added after the length cap, so a long
// reserved-stem name came back one character over the limit — the exact case the cap exists
// for. The prefix is now charged against the budget before the slice.
test("a sanitised name never exceeds the length cap, prefix included", () => {
  const limit = 180;
  for (const stem of ["CON", "com1", "LPT9", "NUL", "aux", "prn"]) {
    for (const tail of ["", ".txt", ".tar.gz"]) {
      const long = `${stem}${"a".repeat(400)}${tail}`;
      assert.ok(
        safeBrowserAssetName(long).length <= limit,
        `${stem}${tail} produced ${String(safeBrowserAssetName(long).length)} characters`,
      );
    }
    const exact = `${stem}.${"a".repeat(limit - stem.length - 1)}`;
    assert.equal(exact.length, limit);
    assert.ok(
      safeBrowserAssetName(exact).length <= limit,
      `a reserved stem at exactly the cap produced ${String(safeBrowserAssetName(exact).length)} characters`,
    );
  }
  assert.ok(safeBrowserAssetName("x".repeat(500)).length <= limit);
});

test("a reserved stem is still neutralised when the name is capped", () => {
  const deviceStem = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
  for (const stem of ["CON", "com1", "LPT9", "NUL"]) {
    const result = safeBrowserAssetName(`${stem}${"a".repeat(400)}`.replace(stem, `${stem}.`));
    assert.equal(deviceStem.test(result), false, `${stem} survived the cap as a device name`);
  }
});

// EX-3. Where a captured browser asset may be written, and what stops it.
const {
  browserAssetDestinationRefusal,
  browserAssetMaximumBytes,
  browserAssetRefusal,
  browserAssetSaveTitle,
} = require("../dist/runtime/assetNaming.js");

test("an asset the transcript does not hold, or cannot download, is refused by name", () => {
  assert.equal(
    browserAssetRefusal({ present: false, downloadAvailable: true }),
    "The browser asset is not present in the transcript",
  );
  assert.equal(
    browserAssetRefusal({ present: true, downloadAvailable: false }),
    "This provider asset does not expose downloadable content",
  );
  assert.equal(browserAssetRefusal({ present: true, downloadAvailable: true }), undefined);
});

const destination = (over = {}) =>
  browserAssetDestinationRefusal({
    parentInsideWorkspace: true,
    destinationInsideWorkspace: true,
    ...over,
  });

test("a parent outside the run's working directory is refused before the file is considered", () => {
  assert.equal(
    destination({ parentInsideWorkspace: false, destinationInsideWorkspace: false, existing: { isSymbolicLink: true } }),
    "Browser assets must be saved inside the run working directory",
  );
});

test("a file that escapes an allowed parent is refused on its own", () => {
  assert.equal(
    destination({ destinationInsideWorkspace: false }),
    "Browser asset destination is outside the run working directory",
  );
});

test("nothing is overwritten, and a symbolic link says so in its own words", () => {
  assert.equal(
    destination({ existing: { isSymbolicLink: false } }),
    "Choose a new filename; browser asset saving does not overwrite files",
  );
  assert.equal(destination({ existing: { isSymbolicLink: true } }), "Refusing to replace a symbolic link");
  assert.equal(destination(), undefined);
});

test("the dialog names a canonical origin, and says nothing when there is not one", () => {
  assert.equal(
    browserAssetSaveTitle("https://provider.example"),
    "Save browser asset linked from https://provider.example",
  );
  assert.equal(browserAssetSaveTitle(undefined), undefined);
});

test("the size ceiling never falls below the floor an ordinary capture needs", () => {
  assert.equal(browserAssetMaximumBytes(52_428_800), 52_428_800);
  assert.equal(browserAssetMaximumBytes(0), 65_536);
  assert.equal(browserAssetMaximumBytes(-1), 65_536);
  assert.equal(browserAssetMaximumBytes(1_000_000_000), 1_000_000_000);
});
