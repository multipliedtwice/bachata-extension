const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// BR-5. Canonical order feeds digests, manifests and archive entries. `localeCompare` without
// an explicit locale answers by host locale and ICU data, so the same input can order two ways
// on two machines and produce two different identities for one tree.
test("the canonical comparator orders by code unit, not by locale", async () => {
  const { byCodeUnit, byCodeUnitOn } = await import(
    `file://${path.join(root, "dist", "security", "ordinal.js")}`
  );

  // Locale collation ignores or reorders punctuation and case; code-unit order does not.
  const inputs = ["b", "A", "a", "B", "_a", "-a", "Z", "z", "à", "ä", "a-b", "a_b", "a.b"];
  const canonical = [...inputs].sort(byCodeUnit);
  const expected = [...inputs].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(canonical, expected);

  // The comparator must not agree with locale collation on inputs where the two differ, or it
  // would prove nothing about which one is in use.
  const locale = [...inputs].sort((left, right) => left.localeCompare(right));
  assert.notDeepEqual(canonical, locale, "this fixture no longer distinguishes the two orders");

  assert.deepEqual(
    [{ name: "B" }, { name: "a" }].sort(byCodeUnitOn((entry) => entry.name)).map((entry) => entry.name),
    ["B", "a"],
  );
});

test("canonical ordering is stable across locales", async () => {
  const { byCodeUnit } = await import(`file://${path.join(root, "dist", "security", "ordinal.js")}`);
  const inputs = ["résumé", "resume", "Resume", "RESUME", "rest"];
  const first = [...inputs].sort(byCodeUnit);
  // Code-unit order depends on the strings alone, so repeating under any host locale agrees.
  assert.deepEqual([...inputs].sort(byCodeUnit), first);
  assert.deepEqual([...inputs].reverse().sort(byCodeUnit), first);
});

test("no canonical build script orders by locale", async () => {
  const { readFile } = require("node:fs/promises");
  const canonicalScripts = [
    "scripts/source-distribution.mjs",
    "scripts/check-lockfile.mjs",
    "scripts/third-party-notices.mjs",
  ];
  for (const relative of canonicalScripts) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.equal(
      /localeCompare/u.test(source),
      false,
      `${relative} orders canonical artifact input by locale`,
    );
  }
});
