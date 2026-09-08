const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAttachmentStore } = require("../dist/attachments/attachmentStore.js");
const { createTranscriptStore } = require("../dist/state/transcriptStore.js");

const temporaryDirectory = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "bachata-storage-"));

const transcriptEntry = (id, text) => ({
  id,
  kind: "answer",
  agentId: "codex",
  step: "review",
  text,
  createdAt: "2026-08-01T00:00:00.000Z",
});

test("transcript store appends, reloads, replaces, and clears JSONL", async () => {
  const directory = temporaryDirectory();
  const logs = [];
  const store = createTranscriptStore(directory, (message) => logs.push(message));

  try {
    await store.append(transcriptEntry("1", "first"));
    await store.append(transcriptEntry("2", "second"));
    assert.deepEqual(await store.load(), [
      transcriptEntry("1", "first"),
      transcriptEntry("2", "second"),
    ]);

    fs.appendFileSync(store.filePath, "not-json\n", "utf8");
    assert.equal((await store.load()).length, 2);
    assert.match(logs.at(-1), /malformed transcript line/);

    await store.replace([transcriptEntry("3", "replacement")]);
    assert.deepEqual(await store.load(), [
      transcriptEntry("3", "replacement"),
    ]);

    await store.clear();
    assert.deepEqual(await store.load(), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("attachment store persists supported images and resolves selected paths", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);

  try {
    const attachment = await store.save({
      id: "image-1",
      name: "screen shot.png",
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      maxBytes: 1024,
    });
    assert.equal(attachment.name, "screen-shot.png");
    assert.equal(attachment.size, 8);

    const resolved = await store.resolvePaths([attachment], ["image-1", "image-1"]);
    assert.equal(resolved.paths.length, 1);
    assert.deepEqual(
      fs.readFileSync(resolved.paths[0]),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.notEqual(
      path.resolve(resolved.paths[0]),
      path.resolve(directory, attachment.relativePath),
      "the adapter is handed the mutable stored file instead of an immutable snapshot",
    );
    await resolved.dispose();
    assert.equal(fs.existsSync(resolved.paths[0]), false, "the snapshot outlived the run");

    await store.remove(attachment);
    await assert.rejects(
      store.resolvePaths([attachment], ["image-1"]),
      /ENOENT/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("attachment store rejects invalid data, oversized files, and path traversal", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);

  try {
    await assert.rejects(
      store.save({
        id: "invalid",
        name: "invalid.png",
        mimeType: "image/png",
        dataBase64: "not base64",
        maxBytes: 1024,
      }),
      /not valid base64/,
    );

    await assert.rejects(
      store.save({
        id: "large",
        name: "large.png",
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgo=",
        maxBytes: 3,
      }),
      /exceeds/,
    );

    await assert.rejects(
      store.resolvePaths(
        [
          {
            id: "outside",
            name: "outside.png",
            mimeType: "image/png",
            size: 1,
            relativePath: "../../outside.png",
          },
        ],
        ["outside"],
      ),
      /outside extension storage/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});



test("attachment store rejects content that does not match the declared image type", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);

  try {
    await assert.rejects(
      store.save({
        id: "mismatch",
        name: "mismatch.png",
        mimeType: "image/png",
        dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64"),
        maxBytes: 1024,
      }),
      /does not match its image type/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("transcript store pages older entries without loading full history into state", async () => {
  const directory = temporaryDirectory();
  const store = createTranscriptStore(directory, () => undefined);
  try {
    for (let index = 1; index <= 8; index += 1) {
      await store.append(transcriptEntry(String(index), `entry-${index}`));
    }
    assert.deepEqual(await store.loadRecent(3), {
      entries: [
        transcriptEntry("6", "entry-6"),
        transcriptEntry("7", "entry-7"),
        transcriptEntry("8", "entry-8"),
      ],
      total: 8,
      hasMore: true,
    });
    assert.deepEqual(await store.loadBefore("6", 3), {
      entries: [
        transcriptEntry("3", "entry-3"),
        transcriptEntry("4", "entry-4"),
        transcriptEntry("5", "entry-5"),
      ],
      total: 8,
      hasMore: true,
    });
    assert.deepEqual(await store.loadBefore("3", 3), {
      entries: [
        transcriptEntry("1", "entry-1"),
        transcriptEntry("2", "entry-2"),
      ],
      total: 8,
      hasMore: false,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("transcript cache reloads external entries before later appends", async () => {
  const directory = temporaryDirectory();
  const store = createTranscriptStore(directory, () => undefined);
  try {
    await store.append(transcriptEntry("1", "first"));
    await store.load();
    fs.appendFileSync(
      store.filePath,
      `${JSON.stringify(transcriptEntry("2", "external"))}\n`,
      "utf8",
    );
    await store.append(transcriptEntry("3", "third"));
    assert.deepEqual(await store.load(), [
      transcriptEntry("1", "first"),
      transcriptEntry("2", "external"),
      transcriptEntry("3", "third"),
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("transcript reads and appends share one serialization boundary", async () => {
  const directory = temporaryDirectory();
  const store = createTranscriptStore(directory, () => undefined, {
    maxEntries: 6_000,
    maxFileBytes: 4 * 1024 * 1024,
  });
  try {
    const entries = Array.from({ length: 5000 }, (_, index) =>
      transcriptEntry(String(index), `entry-${index}-${"x".repeat(256)}`),
    );
    await store.replace(entries);
    fs.appendFileSync(
      store.filePath,
      `${JSON.stringify(transcriptEntry("external", "external"))}
`,
      "utf8",
    );

    const loading = store.load();
    const appending = store.append(transcriptEntry("final", "final"));
    await Promise.all([loading, appending]);

    const loaded = await store.load();
    assert.equal(loaded.at(-2).id, "external");
    assert.equal(loaded.at(-1).id, "final");
    assert.equal(loaded.length, entries.length + 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("transcript store keeps compact previews and bounded history", async () => {
  const directory = temporaryDirectory();
  const store = createTranscriptStore(directory, () => undefined, {
    maxEntries: 3,
    maxFileBytes: 4096,
    maxTextBytes: 256,
    maxDataBytes: 256,
  });
  try {
    for (let index = 1; index <= 5; index += 1) {
      await store.append({
        ...transcriptEntry(String(index), `entry-${index}-${"x".repeat(2048)}`),
        data: { raw: "y".repeat(2048) },
      });
    }
    const loaded = await store.load();
    assert.deepEqual(loaded.map((entry) => entry.id), ["3", "4", "5"]);
    assert.match(loaded[0].text, /Local preview truncated/);
    assert.equal(loaded[0].data.truncated, true);
    assert.ok(fs.statSync(store.filePath).size <= 4096);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("transcript metadata remains accurate after simultaneous cross-process appends", async () => {
  const directory = temporaryDirectory();
  const modulePath = path.resolve(__dirname, "../dist/state/transcriptStore.js");
  const childSource = `
    const { createTranscriptStore } = require(${JSON.stringify(modulePath)});
    const store = createTranscriptStore(process.argv[1], () => undefined);
    process.stdin.once('data', async () => {
      try {
        await store.append({
          id: process.argv[2],
          kind: 'answer',
          agentId: 'codex',
          step: 'review',
          text: process.argv[2],
          createdAt: '2026-08-01T00:00:00.000Z',
        });
        await store.flush();
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    });
    process.stdout.write('ready\\n');
  `;
  try {
    const start = (id) => {
      const child = spawn(process.execPath, ["-e", childSource, directory, id], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const ready = new Promise((resolve, reject) => {
        child.stdout.once("data", resolve);
        child.once("error", reject);
      });
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0
          ? resolve()
          : reject(new Error(`${id} exited ${String(code)}: ${stderr}`)));
      });
      return { child, ready, exited };
    };
    const first = start("first");
    const second = start("second");
    await Promise.all([first.ready, second.ready]);
    first.child.stdin.end("go\n");
    second.child.stdin.end("go\n");
    await Promise.all([first.exited, second.exited]);

    const store = createTranscriptStore(directory, () => undefined);
    const recent = await store.loadRecent(10);
    assert.equal(recent.total, 2);
    assert.deepEqual(recent.entries.map((entry) => entry.id).sort(), ["first", "second"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("attachment backup restores cleared files byte-for-byte", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const attachment = await store.save({
      id: "image-backup",
      name: "backup.png",
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      maxBytes: 1024,
    });
    const backup = await store.backup([attachment]);
    await store.clear([attachment]);
    await assert.rejects(
      store.resolvePaths([attachment], [attachment.id]),
      /ENOENT/u,
    );
    await store.restore(backup);
    const restored = await store.resolvePaths([attachment], [attachment.id]);
    assert.deepEqual(
      fs.readFileSync(restored.paths[0]),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await restored.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("attachment restore rejects corrupted backup bytes", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    await assert.rejects(
      store.restore([{
        metadata: {
          id: "corrupt",
          name: "corrupt.png",
          mimeType: "image/png",
          size: 8,
          relativePath: "attachments/corrupt.png",
        },
        data: Buffer.from("not-image"),
      }]),
      /Attachment backup is invalid/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("attachment restore validates every backup before writing", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const valid = {
      metadata: {
        id: "valid",
        name: "valid.png",
        mimeType: "image/png",
        size: 8,
        relativePath: "attachments/valid.png",
      },
      data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    };
    const invalid = {
      metadata: {
        id: "invalid",
        name: "invalid.png",
        mimeType: "image/png",
        size: 8,
        relativePath: "attachments/invalid.png",
      },
      data: Buffer.from("not-image"),
    };
    await assert.rejects(
      store.restore([valid, invalid]),
      /Attachment backup is invalid/u,
    );
    assert.equal(
      fs.existsSync(path.join(directory, "attachments", "valid.png")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("attachment store accepts bounded UTF-8 text and refuses text that is not decodable", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const spec = Buffer.from("# Spec\nStop after three retries.\n", "utf8");
    const attachment = await store.save({
      id: "spec-1",
      name: "retry spec.md",
      mimeType: "text/markdown",
      dataBase64: spec.toString("base64"),
      maxBytes: 1024,
    });
    assert.equal(attachment.name, "retry-spec.md");
    assert.equal(attachment.size, spec.length);
    assert.equal(attachment.relativePath.endsWith(".md"), true);

    const resolved = await store.resolvePaths([attachment], ["spec-1"]);
    assert.equal(fs.readFileSync(resolved.paths[0], "utf8"), spec.toString("utf8"));
    await resolved.dispose();

    const restored = await store.backup([attachment]);
    assert.equal(restored.length, 1);

    await assert.rejects(
      store.save({
        id: "spec-2",
        name: "binary.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from([0x00, 0x01, 0x02]).toString("base64"),
        maxBytes: 1024,
      }),
      /not decodable UTF-8 text/u,
    );

    await assert.rejects(
      store.save({
        id: "spec-3",
        name: "too-large.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("x".repeat(64), "utf8").toString("base64"),
        maxBytes: 16,
      }),
      /exceeds the 16 byte limit/u,
    );

    await assert.rejects(
      store.save({
        id: "spec-4",
        name: "unknown.bin",
        mimeType: "application/octet-stream",
        dataBase64: Buffer.from("x", "utf8").toString("base64"),
        maxBytes: 1024,
      }),
      /Unsupported attachment type/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an attachment replaced by a same-size symbolic link is refused, not read", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = await store.save({
      id: "image-swap",
      name: "shot.png",
      mimeType: "image/png",
      dataBase64: png.toString("base64"),
      maxBytes: 1024,
    });

    const secret = path.join(directory, "secret.png");
    fs.writeFileSync(secret, Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]));
    const stored = path.join(directory, attachment.relativePath);
    fs.rmSync(stored);
    fs.symlinkSync(secret, stored);

    await assert.rejects(
      store.resolvePaths([attachment], ["image-swap"]),
      /symbolic link/u,
      "a swapped symbolic link was followed and its bytes handed to a provider",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an attachment whose stored bytes no longer match its recorded type is refused", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = await store.save({
      id: "image-tamper",
      name: "shot.png",
      mimeType: "image/png",
      dataBase64: png.toString("base64"),
      maxBytes: 1024,
    });
    fs.writeFileSync(path.join(directory, attachment.relativePath), Buffer.from("not a png!!"));
    await assert.rejects(
      store.resolvePaths([attachment], ["image-tamper"]),
      /invalid/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("backup refuses an attachment replaced by a same-size symbolic link", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = await store.save({
      id: "image-backup-swap",
      name: "shot.png",
      mimeType: "image/png",
      dataBase64: png.toString("base64"),
      maxBytes: 1024,
    });

    const secret = path.join(directory, "SECRET.png");
    fs.writeFileSync(secret, Buffer.from([137, 80, 78, 71, 9, 9, 9, 9]));
    const stored = path.join(directory, attachment.relativePath);
    fs.rmSync(stored);
    fs.symlinkSync(secret, stored);

    await assert.rejects(
      store.backup([attachment]),
      /symbolic link/u,
      "backup followed a swapped symbolic link and captured external bytes",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restore replaces a symlinked attachment path instead of writing through it", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = await store.save({
      id: "image-restore",
      name: "shot.png",
      mimeType: "image/png",
      dataBase64: png.toString("base64"),
      maxBytes: 1024,
    });
    const backup = await store.backup([attachment]);
    await store.clear([attachment]);

    const outside = path.join(directory, "outside.png");
    fs.writeFileSync(outside, Buffer.from("untouched"));
    fs.symlinkSync(outside, path.join(directory, attachment.relativePath));

    await store.restore(backup);
    assert.equal(
      fs.readFileSync(outside, "utf8"),
      "untouched",
      "restore wrote through a symbolic link into a file outside the attachment store",
    );
    assert.deepEqual(fs.readFileSync(path.join(directory, attachment.relativePath)), png);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const savedPngAttachment = async (store, id) => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return store.save({
    id,
    name: "shot.png",
    mimeType: "image/png",
    dataBase64: png.toString("base64"),
    maxBytes: 1024,
  });
};

test("an attachments directory replaced by a symbolic link is refused, not read through", async () => {
  const directory = temporaryDirectory();
  const outside = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const attachment = await savedPngAttachment(store, "ancestor-swap");
    const attachmentsDirectory = path.join(directory, "attachments");
    const decoy = path.join(outside, path.basename(attachment.relativePath));
    fs.writeFileSync(decoy, Buffer.from([137, 80, 78, 71, 9, 9, 9, 9]));
    fs.rmSync(attachmentsDirectory, { recursive: true, force: true });
    fs.symlinkSync(outside, attachmentsDirectory);

    await assert.rejects(
      store.resolvePaths([attachment], ["ancestor-swap"]),
      /symbolic link|does not own/u,
      "a symlinked attachments directory was read through and external bytes were snapshotted",
    );
    await assert.rejects(
      store.backup([attachment]),
      /symbolic link|does not own/u,
      "a symlinked attachments directory was read through by backup",
    );
    await assert.rejects(
      savedPngAttachment(store, "ancestor-write"),
      /symbolic link|does not own/u,
      "a symlinked attachments directory was written through by save",
    );
    assert.equal(
      fs.readdirSync(outside).sort().join(","),
      path.basename(attachment.relativePath),
      "Bachata wrote into a directory outside its own storage",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("an attachment snapshot directory replaced by a symbolic link is refused", async () => {
  const directory = temporaryDirectory();
  const outside = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const attachment = await savedPngAttachment(store, "snapshot-ancestor");
    fs.symlinkSync(outside, path.join(directory, "attachment-snapshots"));

    await assert.rejects(
      store.resolvePaths([attachment], ["snapshot-ancestor"]),
      /symbolic link|does not own/u,
      "plaintext snapshots were written through a symlinked snapshot directory",
    );
    assert.deepEqual(fs.readdirSync(outside), [], "a snapshot was written outside Bachata's storage");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("an attachments directory replaced by a regular file is refused", async () => {
  const directory = temporaryDirectory();
  const store = createAttachmentStore(directory);
  try {
    const attachment = await savedPngAttachment(store, "ancestor-file");
    fs.rmSync(path.join(directory, "attachments"), { recursive: true, force: true });
    fs.writeFileSync(path.join(directory, "attachments"), "not a directory");

    await assert.rejects(
      store.resolvePaths([attachment], ["ancestor-file"]),
      /which is not a directory/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native attachment ownership preserves Windows volume and full inode checks before reading or writing", async (context) => {
  const filename = require.resolve("../dist/attachments/attachmentStore.js");
  const source = fs.readFileSync(filename, "utf8");
  const moduleRequire = require("node:module").createRequire(filename);
  const filesystem = require("node:fs/promises");
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const scenario of [
    { name: "missing pathname volume uses a verified root", success: true },
    { name: "wider pathname volume preserves its low bits", wide: true, success: true },
    { name: "directory on another volume refuses writes", directoryMismatch: true },
    { name: "unavailable root refuses writes", rootUnavailable: true },
    { name: "zero root volume refuses writes", rootZero: true },
    { name: "file on another volume refuses reads", fileMismatch: true },
    { name: "file inode mismatch above safe integer precision refuses reads", inodeMismatch: true },
    { name: "pathname replacement refuses reads", pathReplacement: true },
    { name: "file replaced by a symlink at open refuses reads", symlinkRace: true },
  ]) {
    await context.test(scenario.name, async () => {
      const directory = temporaryDirectory();
      const canonicalDirectory = await filesystem.realpath(directory);
      const root = path.parse(canonicalDirectory).root;
      const attachmentDirectory = path.join(directory, "attachments");
      const stored = path.join(attachmentDirectory, "image.png");
      const handles = new Set();
      let reads = 0;
      let writes = 0;
      let selectedStats = 0;
      const metadata = { id: "image", name: "image.png", mimeType: "image/png", size: png.length, relativePath: path.join("attachments", "image.png") };
      const reading = scenario.fileMismatch || scenario.inodeMismatch || scenario.pathReplacement || scenario.symlinkRace;
      try {
        if (reading) {
          await filesystem.mkdir(attachmentDirectory);
          await filesystem.writeFile(stored, png);
        }
        const identity = (details, dev, ino = details.ino) => Object.assign(Object.create(details), { dev, ino });
        const pathDevice = scenario.wide ? 0x1234_5678_0000_002an : 0n;
        const fileInode = 0x20_0000_0000_0000n;
        const injectedFs = {
          ...filesystem,
          lstat: async (target, options) => {
            assert.equal(options.bigint, true);
            const details = await filesystem.lstat(target, options);
            if (target === stored) selectedStats += 1;
            return identity(details, pathDevice, target === stored
              ? fileInode + (scenario.pathReplacement && selectedStats > 1 ? 1n : 0n) : details.ino);
          },
          open: async (target, ...args) => {
            if (target === root && scenario.rootUnavailable) throw new Error("root unavailable");
            if (target === stored && scenario.symlinkRace) {
              const replacement = path.join(directory, "outside.png");
              await filesystem.writeFile(replacement, png);
              await filesystem.rm(stored);
              await filesystem.symlink(replacement, stored);
              args[0] &= ~(filesystem.constants.O_NOFOLLOW ?? 0);
            }
            const handle = await filesystem.open(target, ...args);
            handles.add(handle);
            return {
              stat: async (options) => {
                assert.equal(options.bigint, true);
                const details = await handle.stat(options);
                const dev = target === root ? scenario.rootZero ? 0n : 42n
                  : target === attachmentDirectory && scenario.directoryMismatch || target === stored && scenario.fileMismatch ? 43n : 42n;
                return identity(details, dev, target === stored ? fileInode + (scenario.inodeMismatch ? 1n : 0n) : details.ino);
              },
              readFile: async (...args) => {
                reads += 1;
                assert.notEqual(target, root, "filesystem-root bytes must never be read");
                return handle.readFile(...args);
              },
              close: async () => { await handle.close(); handles.delete(handle); },
            };
          },
          writeFile: async (...args) => { writes += 1; return filesystem.writeFile(...args); },
        };
        const createStore = require("node:vm").runInNewContext(
          `${source}\nexports.createAttachmentStore;`,
          {
            exports: {},
            require: (name) => name === "node:fs/promises" ? injectedFs : moduleRequire(name),
            process: { platform: "win32" },
            Buffer,
            structuredClone,
          },
          { timeout: 1000 },
        );
        const store = createStore(directory);
        if (scenario.success) {
          const saved = await savedPngAttachment(store, "image");
          const backup = await store.backup([saved]);
          assert.deepEqual(backup[0].data, png);
          const resolved = await store.resolvePaths([saved], ["image"]);
          try {
            assert.deepEqual(await filesystem.readFile(resolved.paths[0]), png);
          } finally {
            await resolved.dispose();
          }
          assert.equal(reads, 2);
          assert.equal(writes, 2);
        } else {
          await assert.rejects(reading ? store.backup([metadata]) : savedPngAttachment(store, "image"), /changed|replaced|cannot establish|root unavailable/u);
          assert.equal(reads, 0, "unverified attachment bytes were read");
          assert.equal(writes, 0, "an unverified directory was written through");
        }
        assert.equal(handles.size, 0, "every owned descriptor must close");
      } finally {
        await Promise.all([...handles].map((handle) => handle.close()));
        await filesystem.rm(directory, { recursive: true, force: true });
      }
    });
  }
});
