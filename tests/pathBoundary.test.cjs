const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  isPathInsideRoot,
  normalizePathIdentity,
  pathInsideRelative,
  samePathIdentity,
} = require("../dist/process/pathBoundary.js");
const { sha256FilePath } = require("../dist/security/fileHash.js");

test("pathInsideRelative accepts strictly-inside paths and the root itself", () => {
  const root = path.resolve("/tmp", "bachata-boundary-root");
  assert.equal(pathInsideRelative(root, path.join(root, "src", "a.ts")), path.join("src", "a.ts"));
  assert.equal(pathInsideRelative(root, root), "");
});

test("pathInsideRelative rejects siblings escapes and unrelated absolute paths", () => {
  const root = path.resolve("/tmp", "bachata-boundary-root");
  assert.equal(pathInsideRelative(root, path.join(root, "..", "sibling")), undefined);
  assert.equal(pathInsideRelative(root, "/etc/passwd"), undefined);
  assert.equal(isPathInsideRoot(root, path.join(root, "..")), false);
});

test("pathInsideRelative normalizes dot segments and trailing separators", () => {
  const root = path.resolve("/tmp", "bachata-boundary-root");
  assert.equal(
    pathInsideRelative(path.join(root, "src") + path.sep, path.join(root, "src", ".", "b.ts")),
    "b.ts",
  );
  assert.equal(isPathInsideRoot(root + path.sep, path.join(root, "c.ts")), true);
});

test("normalizePathIdentity folds case only where the platform is case-insensitive", () => {
  const folded = normalizePathIdentity("/Root/Dir");
  if (process.platform === "win32") {
    assert.equal(folded, "/root/dir");
  } else {
    assert.equal(folded, "/Root/Dir");
  }
});

test("samePathIdentity equates paths that resolve to the same identity", () => {
  assert.equal(samePathIdentity("/tmp/x/./y", path.resolve("/tmp/x/y")), true);
  assert.equal(samePathIdentity("/tmp/x/y", "/tmp/x/z"), false);
});

test("sha256FilePath matches the reference digest for known content", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-filehash-"));
  try {
    const target = path.join(directory, "content.bin");
    fs.writeFileSync(target, Buffer.from("Bachata file hash fixture\n"));
    const digest = await sha256FilePath(target);
    const expected = require("node:crypto")
      .createHash("sha256")
      .update(Buffer.from("Bachata file hash fixture\n"))
      .digest("hex");
    assert.equal(digest, expected);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a pre-aborted signal cancels file hashing before it reads", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-hash-abort-"));
  try {
    const target = path.join(directory, "content.txt");
    fs.writeFileSync(target, "Bachata", "utf8");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(sha256FilePath(target, controller.signal), /File hashing interrupted/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
