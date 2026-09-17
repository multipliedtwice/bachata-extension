const assert = require("node:assert/strict");
const test = require("node:test");

const {
  describeFileIdentity,
  sameFileIdentity,
  usableFileIdentity,
} = require("../dist/process/fileIdentity.js");

const stats = (dev, ino) => ({ dev, ino });

test("two stats of one file are the same file", () => {
  assert.equal(sameFileIdentity(stats(1, 42), stats(1, 42)), true);
});

test("a different inode or device is a different file", () => {
  assert.equal(sameFileIdentity(stats(1, 42), stats(1, 43)), false);
  assert.equal(sameFileIdentity(stats(1, 42), stats(2, 42)), false);
});

// Windows reports 0 where the filesystem exposes no file index. Reading that as "a different
// file" refused every directory the extension validated there, so it means "unavailable" and the
// caller falls back to the type and size checks it already makes.
test("an absent inode means the identity is unavailable, not that the files differ", () => {
  assert.equal(usableFileIdentity(stats(1, 0)), false);
  assert.equal(sameFileIdentity(stats(1, 0), stats(1, 42)), true);
  assert.equal(sameFileIdentity(stats(1, 42), stats(2, 0)), true);
  assert.equal(sameFileIdentity(stats(1, 0), stats(2, 0)), true);
});

// Windows reports dev 0 from a path stat and the real volume from a handle stat of the same
// file. The file index is what identifies the file there, so an absent device is unknown rather
// than different, while two known and different devices still name two files.
test("an absent device number is unknown rather than different", () => {
  assert.equal(sameFileIdentity(stats(0, 42), stats(3606225537, 42)), true);
  assert.equal(sameFileIdentity(stats(3606225537, 42), stats(0, 42)), true);
  assert.equal(sameFileIdentity(stats(0, 42), stats(0, 43)), false);
  assert.equal(sameFileIdentity(stats(0, 42), stats(3606225537, 43)), false);
});

test("a negative or unreadable inode is treated as absent rather than compared", () => {
  assert.equal(usableFileIdentity(stats(1, -1)), false);
  assert.equal(usableFileIdentity(stats(1, Number.NaN)), false);
  assert.equal(usableFileIdentity(stats(1, undefined)), false);
  assert.equal(sameFileIdentity(stats(1, Number.NaN), stats(1, 42)), true);
});

test("a usable inode is reported, and an absent one says so", () => {
  assert.equal(usableFileIdentity(stats(1, 42)), true);
  assert.equal(describeFileIdentity(stats(1, 42)), "dev 1 inode 42");
  assert.equal(describeFileIdentity(stats(1, 0)), "no inode");
});
