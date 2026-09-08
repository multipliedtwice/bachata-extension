const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm, symlink } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  canonicalWorkspaceStateIdentity,
} = require("../dist/state/workspaceIdentity.js");

test("workspace state identity is derived only from the immutable storage root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-workspace-identity-"));
  const storageRoot = path.join(root, "workspace-storage");
  await mkdir(storageRoot);
  try {
    const first = canonicalWorkspaceStateIdentity(storageRoot);
    const second = canonicalWorkspaceStateIdentity(storageRoot);
    assert.equal(first, second);
    assert.equal(first.startsWith("storage:"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace state identity canonicalizes an existing storage symlink", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-workspace-identity-link-"));
  const storageRoot = path.join(root, "workspace-storage");
  const linkedRoot = path.join(root, "workspace-storage-link");
  await mkdir(storageRoot);
  await symlink(storageRoot, linkedRoot, "dir");
  try {
    assert.equal(
      canonicalWorkspaceStateIdentity(linkedRoot),
      canonicalWorkspaceStateIdentity(storageRoot),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("workspace state identity stays stable when a missing storage directory is created through a symlinked ancestor", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-workspace-identity-missing-link-"));
  const realParent = path.join(root, "real-parent");
  const linkedParent = path.join(root, "linked-parent");
  const realStorage = path.join(realParent, "workspace-storage");
  const linkedStorage = path.join(linkedParent, "workspace-storage");
  await mkdir(realParent);
  await symlink(realParent, linkedParent, "dir");
  try {
    const beforeCreation = canonicalWorkspaceStateIdentity(linkedStorage);
    await mkdir(realStorage);
    const afterCreation = canonicalWorkspaceStateIdentity(realStorage);
    assert.equal(beforeCreation, afterCreation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
