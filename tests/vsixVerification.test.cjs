const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const verifierPath = path.join(__dirname, "..", "scripts", "verify-vsix.mjs");
const { webviewRuntimeAssets } = require("../dist/webview/assets.js");

test("the VSIX verifier CLI refuses invocation without an artifact on every platform", () => {
  const result = spawnSync(process.execPath, [verifierPath], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected VSIX path/u);
});

test("packaged Markdown uses VSCE link rewriting without accepting changed copy", async () => {
  const { packagedDocumentContents } = await import("../scripts/verify-vsix.mjs");
  const manifest = { repository: { url: "https://github.com/fixture/bachata.git" } };
  const source = Buffer.from('Read [guide](docs/GUIDE.md).\n<img src="media/header.png">\n[Usage](#usage)\n');
  const expected = Buffer.from('Read [guide](https://github.com/fixture/bachata/blob/HEAD/docs/GUIDE.md).\n'
    + '<img src="https://github.com/fixture/bachata/raw/HEAD/media/header.png">\n[Usage](#usage)\n');
  for (const name of ["README.md", "CHANGELOG.md"]) {
    assert.deepEqual(await packagedDocumentContents(name, source, manifest), expected);
    assert.notDeepEqual(await packagedDocumentContents(name, Buffer.from("Changed copy\n"), manifest), expected);
  }
  assert.deepEqual(await packagedDocumentContents("docs/GUIDE.md", source, manifest), source);
});

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let index = 0; index < 8; index += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const value of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};

const uint16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

const uint32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
};

const writeStoreZip = (target, entries) => {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const crc = crc32(data);
    const header = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(0x800), uint16(0),
      uint16(0), uint16(33), uint32(crc), uint32(data.length), uint32(data.length),
      uint16(name.length), uint16(0), name,
    ]);
    local.push(header, data);
    central.push(Buffer.concat([
      uint32(0x02014b50), uint16(0x0314), uint16(20), uint16(0x800), uint16(0),
      uint16(0), uint16(33), uint32(crc), uint32(data.length), uint32(data.length),
      uint16(name.length), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(0o100644 << 16), uint32(offset), name,
    ]));
    offset += header.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralBuffer.length), uint32(offset), uint16(0),
  ]);
  require("node:fs").writeFileSync(target, Buffer.concat([...local, centralBuffer, end]));
};

const manifest = {
  main: "./dist/extension.js",
  icon: "media/icon.png",
  contributes: {
    walkthroughs: [{
      id: "bachata.gettingStarted",
      steps: [
        { id: "one", media: { markdown: "media/walkthrough-setup.md" } },
        { id: "two", media: { image: "media/icon.svg" } },
      ],
    }],
  },
};

test("VSIX verification requires manifest-referenced runtime assets", async () => {
  const { manifestAssets, requiredVsixEntries, missingVsixEntries } = await import(verifierPath);

  assert.deepEqual(manifestAssets(manifest), [
    "dist/extension.js",
    "media/icon.png",
    "media/walkthrough-setup.md",
    "media/icon.svg",
  ]);

  const required = requiredVsixEntries(manifest, [
    "presets/codex-review.pipeline.json",
    "protocol/browser-protocol-v9.contract.json",
    ...webviewRuntimeAssets(),
  ]);
  for (const entry of [
    "extension/package.json",
    "extension/dist/extension.js",
    "extension/dist/webview.js",
    "extension/dist/webview-behavior.js",
    "extension/scripts/process-scope.cjs",
    "extension/media/icon.png",
    "extension/media/walkthrough-setup.md",
    "extension/presets/codex-review.pipeline.json",
    "extension/protocol/browser-protocol-v9.contract.json",
    "extension/dist/webview.css",
    "extension/dist/vendor/codicons/codicon.css",
    "extension/dist/vendor/codicons/codicon.ttf",
    "extension/dist/vendor/prism/prism.js",
    "extension/dist/vendor/prism/components/prism-typescript.js",
  ]) {
    assert.equal(required.includes(entry), true, `Missing requirement: ${entry}`);
  }

  const complete = new Set(required);
  assert.deepEqual(missingVsixEntries(complete, required), []);

  const broken = new Set(required);
  broken.delete("extension/media/walkthrough-setup.md");
  broken.delete("extension/presets/codex-review.pipeline.json");
  assert.deepEqual(missingVsixEntries(broken, required), [
    "extension/presets/codex-review.pipeline.json",
    "extension/media/walkthrough-setup.md",
  ]);
});

test("stale packaged runtime files are rejected against the current build", async () => {
  const { staleVsixEntries } = await import(verifierPath);

  const build = {
    "dist/extension.js": "a".repeat(64),
    "dist/webview.js": "b".repeat(64),
    "dist/webview.css": "c".repeat(64),
  };
  assert.deepEqual(staleVsixEntries(build, { ...build }), []);
  assert.deepEqual(
    staleVsixEntries(build, { ...build, "dist/webview.css": "d".repeat(64) }),
    ["dist/webview.css"],
  );
  assert.deepEqual(
    staleVsixEntries(build, { "dist/extension.js": build["dist/extension.js"] }),
    ["dist/webview.css", "dist/webview.js"],
  );
});

test("the webview asset manifest matches what the packaged HTML loads", () => {
  const Module = require("node:module");
  const vscodeStub = {
    Uri: {
      joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join("/") }),
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === "vscode" ? vscodeStub : originalLoad.call(this, request, parent, isMain);
  };
  let getWebviewHtml;
  try {
    const htmlPath = require.resolve("../dist/webview/html.js");
    delete require.cache[htmlPath];
    ({ getWebviewHtml } = require(htmlPath));
  } finally {
    Module._load = originalLoad;
  }

  const html = getWebviewHtml(
    {
      cspSource: "vscode-resource:",
      asWebviewUri: (uri) => ({ toString: () => `vscode-resource:/${uri.path}` }),
    },
    { path: "/extension" },
  );

  const fs = require("node:fs");
  const codiconCss = fs.readFileSync(
    path.join(__dirname, "..", "dist", "vendor", "codicons", "codicon.css"),
    "utf8",
  );

  for (const asset of webviewRuntimeAssets()) {
    if (asset.endsWith(".ttf")) {
      assert.ok(
        codiconCss.includes(asset.split("/").at(-1)),
        `${asset} is declared but no packaged stylesheet loads it`,
      );
      continue;
    }
    assert.ok(
      html.includes(`vscode-resource://extension/${asset}`),
      `${asset} is declared but never loaded by the webview HTML`,
    );
  }
});

test("archive entry names are validated and duplicates rejected", async () => {
  const { unsafeVsixEntryReason } = await import(verifierPath);

  assert.equal(unsafeVsixEntryReason("extension/dist/extension.js"), undefined);
  assert.equal(unsafeVsixEntryReason("extension.vsixmanifest"), undefined);
  assert.equal(unsafeVsixEntryReason("[Content_Types].xml"), undefined);
  assert.match(unsafeVsixEntryReason("extension/../evil.js"), /traversal/u);
  assert.match(unsafeVsixEntryReason("/etc/passwd"), /absolute/u);
  assert.match(unsafeVsixEntryReason("C:/windows/system32"), /absolute/u);
  assert.match(unsafeVsixEntryReason("extension\\dist\\extension.js"), /backslash/u);
  assert.match(unsafeVsixEntryReason("extension/dist/bad\u0007name.js"), /control character/u);
  assert.match(unsafeVsixEntryReason("payload/other.js"), /outside the extension payload/u);
  assert.match(unsafeVsixEntryReason(""), /empty/u);
});

test("verification rejects unsafe, duplicate, and self-executing archives without running their code", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { verifyVsix } = await import(verifierPath);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-vsix-negative-"));
  const marker = path.join(directory, "executed-marker");
  try {
    const unsafe = path.join(directory, "unsafe.vsix");
    writeStoreZip(unsafe, [{ name: "extension/../evil.js", content: "module.exports = 1;\n" }]);
    await assert.rejects(verifyVsix(unsafe), /Unsafe VSIX entry|invalid relative path/u);

    const outside = path.join(directory, "outside.vsix");
    writeStoreZip(outside, [{ name: "payload/evil.js", content: "module.exports = 1;\n" }]);
    await assert.rejects(verifyVsix(outside), /Unsafe VSIX entry/u);

    const duplicate = path.join(directory, "duplicate.vsix");
    writeStoreZip(duplicate, [
      { name: "extension/package.json", content: "{}\n" },
      { name: "extension/package.json", content: "{}\n" },
    ]);
    await assert.rejects(verifyVsix(duplicate), /Duplicate VSIX entry/u);

    const hostile = path.join(directory, "hostile.vsix");
    writeStoreZip(hostile, [
      { name: "extension/package.json", content: JSON.stringify({ name: "bachata-vscode" }) },
      {
        name: "extension/dist/webview/assets.js",
        content: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\nmodule.exports = { webviewRuntimeAssets: () => [] };\n`,
      },
    ]);
    await assert.rejects(verifyVsix(hostile));
    assert.equal(fs.existsSync(marker), false, "the verifier executed code from the archive");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("packaged first-party sources are compared against the working tree", async () => {
  const { packagedSourceEquivalence, staleVsixEntries } = await import(verifierPath);

  const pairs = packagedSourceEquivalence([
    "package.json",
    "presets/codex-review.pipeline.json",
    "protocol/browser-protocol-v9.contract.json",
    "scripts/process-scope.cjs",
  ]);
  assert.deepEqual(pairs[0], { source: "package.json", packaged: "extension/package.json" });
  assert.equal(pairs.length, 4);

  const build = {
    "package.json": "a".repeat(64),
    "presets/codex-review.pipeline.json": "b".repeat(64),
    "scripts/process-scope.cjs": "c".repeat(64),
  };
  assert.deepEqual(staleVsixEntries(build, { ...build }), []);
  assert.deepEqual(
    staleVsixEntries(build, { ...build, "presets/codex-review.pipeline.json": "z".repeat(64) }),
    ["presets/codex-review.pipeline.json"],
  );
});
