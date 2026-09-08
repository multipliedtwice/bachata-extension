const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { setOptionalProperty } = require("../dist/state/optionalProperty.js");

const root = path.resolve(__dirname, "..");

test("setOptionalProperty removes the key when the value is undefined", () => {
  const target = { kept: 1, cleared: "value" };
  setOptionalProperty(target, "cleared", undefined);
  assert.equal(Object.hasOwn(target, "cleared"), false);
  assert.equal("cleared" in target, false);
  assert.deepEqual(Object.keys(target), ["kept"]);
});

test("setOptionalProperty writes the key when the value is defined", () => {
  const target = {};
  setOptionalProperty(target, "value", "set");
  assert.equal(Object.hasOwn(target, "value"), true);
  assert.equal(target.value, "set");
});

test("setOptionalProperty clearing survives a structured clone as an absent key", () => {
  const target = { value: "set" };
  setOptionalProperty(target, "value", undefined);
  const cloned = structuredClone(target);
  assert.equal(Object.hasOwn(cloned, "value"), false);
});

test("an assigned undefined survives a structured clone as a present key", () => {
  const target = { value: "set" };
  target.value = undefined;
  const cloned = structuredClone(target);
  assert.equal(Object.hasOwn(cloned, "value"), true);
  assert.equal(cloned.value, undefined);
});

test("a cleared key lets a spread merge fall through to the base value", () => {
  const base = { value: "base" };
  const patch = { value: "patch" };
  setOptionalProperty(patch, "value", undefined);
  assert.deepEqual({ ...base, ...patch }, { value: "base" });
});

test("an assigned undefined overwrites the base value in a spread merge", () => {
  const base = { value: "base" };
  const patch = { value: "patch" };
  patch.value = undefined;
  const merged = { ...base, ...patch };
  assert.equal(Object.hasOwn(merged, "value"), true);
  assert.equal(merged.value, undefined);
});

test("JSON.stringify cannot tell a cleared key from an assigned undefined", () => {
  const cleared = { value: "set" };
  setOptionalProperty(cleared, "value", undefined);
  const assigned = { value: undefined };
  assert.equal(JSON.stringify(cleared), JSON.stringify(assigned));
  assert.notEqual(Object.hasOwn(cleared, "value"), Object.hasOwn(assigned, "value"));
});

test("setOptionalProperty leaves an already absent key absent", () => {
  const target = { kept: 1 };
  setOptionalProperty(target, "missing", undefined);
  assert.deepEqual(Object.keys(target), ["kept"]);
});

const helperBody = (relative) => {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  return source
    .replace(/^\/\*\*[\s\S]*?\*\/\n\n/u, "")
    .replace(/^export const /mu, "const ")
    .trim();
};

test("the webview copy of the helper matches the extension-host module", () => {
  assert.equal(
    helperBody("src/webview-ui/optionalProperty.ts"),
    helperBody("src/state/optionalProperty.ts"),
    "src/webview-ui/optionalProperty.ts and src/state/optionalProperty.ts have drifted; the webview bundle cannot import the module, so the two copies are kept identical by hand",
  );
});
