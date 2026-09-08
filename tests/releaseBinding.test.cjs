const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const root = path.join(__dirname, "..");
const load = () => import(pathToFileURL(path.join(root, "scripts", "lib", "bindReleaseArtifacts.mjs")).href);
const bridgeCompatibility = JSON.parse(
  fs.readFileSync(path.join(root, "protocol", "browser-bridge.compatibility.json"), "utf8"),
);
const pinnedBridgeFileName =
  `${bridgeCompatibility.browserBridgePackage}-${bridgeCompatibility.browserBridgeVersion}.zip`;
const parent = path.resolve(root, "..");
const pinnedBridgeCandidates = [
  path.join(root, pinnedBridgeFileName),
  path.join(parent, pinnedBridgeFileName),
  path.join(parent, "browser-bridge", pinnedBridgeFileName),
  path.join(parent, `${bridgeCompatibility.browserBridgePackage}-${bridgeCompatibility.browserBridgeVersion}`, pinnedBridgeFileName),
];
const pinnedBridgeArchivePresent = pinnedBridgeCandidates.some((candidate) => fs.existsSync(candidate));

// EX-AUD-08. A clean checkout has no Browser Bridge archive — it is produced by the other
// repository — so these cases skip, and skipping is correct there. In the paired release job
// the archive is fetched before the suite runs, and a skip there would report a release as
// verified when the artifact half was never exercised. `BACHATA_REQUIRE_RELEASE_ARTIFACTS`
// turns the absence into a failure, and the release workflow sets it.
const releaseArtifactsRequired = process.env.BACHATA_REQUIRE_RELEASE_ARTIFACTS === "1";
if (releaseArtifactsRequired && !pinnedBridgeArchivePresent) {
  test("the release job has the Browser Bridge archive it must verify", () => {
    assert.fail(
      `BACHATA_REQUIRE_RELEASE_ARTIFACTS is set but no ${pinnedBridgeFileName} was found in:\n`
        + pinnedBridgeCandidates.map((candidate) => `- ${candidate}`).join("\n"),
    );
  });
}
const requiresPinnedBridgeArchive = {
  skip: pinnedBridgeArchivePresent || releaseArtifactsRequired
    ? false
    : `no staged Browser Bridge archive named ${pinnedBridgeFileName}`,
};

const artifacts = {
  vsix: { label: "Bachata VSIX", sha256: "a".repeat(64), version: "0.6.12" },
  bridge: { label: "Browser Bridge ZIP", sha256: "b".repeat(64), version: "0.6.7" },
};

const record = (rows) => [
  "# Record",
  "",
  `Artifacts under test: Bachata VSIX \`${"c".repeat(64)}\`, Browser Bridge ZIP \`${"d".repeat(64)}\`.`,
  "",
  "| Artifact | Version | SHA-256 | Recorded |",
  "| --- | --- | --- | --- |",
  "| Bachata VSIX | 0.0.0 | `" + "c".repeat(64) + "` | yes |",
  "| Browser Bridge ZIP | 0.0.0 | `" + "d".repeat(64) + "` | yes |",
  "",
  "| OS | VSIX SHA-256 | Date | Operator | Result | Notes |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows,
  "",
].join("\n");

test("binding rewrites the binding line and the artifact table", async () => {
  const { planDocumentBinding } = await load();
  const plan = planDocumentBinding({
    relative: "docs/RELEASE_VALIDATION_RECORD.md",
    original: record(["| macOS | — | — | — | Not performed | — |"]),
    artifacts,
    schemas: {},
  });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.voided, 0);
  assert.deepEqual(plan.unbindable, []);
  assert.equal(plan.next.includes(`Bachata VSIX \`${"a".repeat(64)}\``), true);
  assert.match(plan.next, /\| Bachata VSIX \| 0\.6\.12 \| `a{64}` \| yes \|/u);
  assert.equal(plan.next.includes("c".repeat(64)), false, "a stale hash survived the rebinding");
});

test("a row produced against another artifact is voided", async () => {
  const { planDocumentBinding } = await load();
  const plan = planDocumentBinding({
    relative: "docs/RELEASE_VALIDATION_RECORD.md",
    original: record([`| macOS | \`${"c".repeat(64)}\` | 2026-08-01 | t | pass | none |`]),
    artifacts,
    schemas: {},
  });
  assert.equal(plan.voided, 1);
  assert.match(plan.next, /\| macOS \| — \| — \| — \| Not performed \| — \|/u);
});

test("a row already naming the current artifact is left alone", async () => {
  const { planDocumentBinding } = await load();
  const plan = planDocumentBinding({
    relative: "docs/RELEASE_VALIDATION_RECORD.md",
    original: record([`| macOS | \`${"a".repeat(64)}\` | 2026-08-01 | t | pass | none |`]),
    artifacts,
    schemas: {},
  });
  assert.equal(plan.voided, 0);
  assert.deepEqual(plan.unbindable, []);
  assert.match(plan.next, /\| macOS \| `a{64}` \| 2026-08-01 \| t \| pass \| none \|/u);
});

test("an unrecorded row is never reported as unbindable", async () => {
  const { planDocumentBinding } = await load();
  const plan = planDocumentBinding({
    relative: "docs/RELEASE_VALIDATION_RECORD.md",
    original: record([
      "| macOS | — | — | — | Not performed | — |",
      "| Linux | — | — | — | Not performed | — |",
    ]),
    artifacts,
    schemas: {},
  });
  assert.deepEqual(plan.unbindable, []);
  assert.equal(plan.voided, 0);
});

test("a recorded row with no hash column is reported, not silently rebound", async () => {
  const { planDocumentBinding } = await load();
  const original = [
    "# Record",
    "",
    `Artifacts under test: Bachata VSIX \`${"c".repeat(64)}\`, Browser Bridge ZIP \`${"d".repeat(64)}\`.`,
    "",
    "| Step | Date | Result | Notes |",
    "| --- | --- | --- | --- |",
    "| Install from verified ZIP | 2026-08-01 | pass | none |",
    "",
  ].join("\n");
  const reported = planDocumentBinding({
    relative: "docs/RELEASE_VALIDATION_RECORD.md",
    original,
    artifacts,
    schemas: {},
  });
  assert.equal(reported.voided, 0);
  assert.equal(reported.unbindable.length, 1);
  assert.match(reported.unbindable[0], /Install from verified ZIP \(its table declares no artifact column\)/u);
  assert.equal(reported.next.includes("pass"), true, "the row was cleared without being asked");

  const cleared = planDocumentBinding({
    relative: "docs/RELEASE_VALIDATION_RECORD.md",
    original,
    artifacts,
    voidUnbindable: true,
    schemas: {},
  });
  assert.equal(cleared.voided, 1);
  assert.match(cleared.next, /\| Install from verified ZIP \| — \| Not performed \| — \|/u);
});

test("the verdict document is bound but never has its measurements voided", async () => {
  const { planDocumentBinding, RECORD_DOCUMENTS } = await load();
  assert.equal(RECORD_DOCUMENTS.has("docs/RELEASE_VERDICT.md"), false);
  const original = [
    "# Release verdict",
    "",
    `Artifacts under test: Bachata VSIX \`${"c".repeat(64)}\`, Browser Bridge ZIP \`${"d".repeat(64)}\`.`,
    "",
    "| Gate | Result |",
    "| --- | --- |",
    "| npm test | pass |",
    "",
  ].join("\n");
  const plan = planDocumentBinding({ relative: "docs/RELEASE_VERDICT.md", original, artifacts, schemas: {} });
  assert.equal(plan.voided, 0);
  assert.deepEqual(plan.unbindable, []);
  assert.match(plan.next, /\| npm test \| pass \|/u);
  assert.equal(plan.next.includes(`Bachata VSIX \`${"a".repeat(64)}\``), true);
});

test("a malformed table is a problem, so nothing is written", async () => {
  const { planDocumentBinding } = await load();
  const plan = planDocumentBinding({
    relative: "docs/COMPATIBILITY_MATRIX.md",
    original: [
      "# Matrix",
      "",
      `Artifacts under test: Bachata VSIX \`${"a".repeat(64)}\`, Browser Bridge ZIP \`${"b".repeat(64)}\`.`,
      "",
      "| Extension | Result |",
      "| --- | --- |",
      "| 0.6.12 | pass | extra |",
      "",
    ].join("\n"),
    artifacts,
    schemas: {},
  });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /has 3 cells but its table declares 2 columns/u);
});

test("a document with no binding line is refused", async () => {
  const { planDocumentBinding } = await load();
  const plan = planDocumentBinding({
    relative: "docs/PROVIDER_TERMS.md",
    original: "# Terms\n\nNothing to bind.\n",
    artifacts,
    schemas: {},
  });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /declares no "Artifacts under test:" line/u);
});

test("every binding document exists and every record document is a binding document", async () => {
  const { BINDING_DOCUMENTS, RECORD_DOCUMENTS } = await load();
  BINDING_DOCUMENTS.forEach((relative) => {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} is missing`);
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /^Artifacts?\s+under\s+test:/imu, `${relative} declares no binding line`);
  });
  [...RECORD_DOCUMENTS].forEach((relative) => {
    assert.equal(BINDING_DOCUMENTS.includes(relative), true, `${relative} is not bound`);
  });
});

test("no artifact-binding document is packaged inside the artifact it names", async () => {
  const { BINDING_DOCUMENTS } = await load();
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  BINDING_DOCUMENTS.forEach((relative) => {
    assert.equal(
      packageJson.files.includes(relative),
      false,
      `${relative} ships inside the VSIX whose hash it records`,
    );
  });
  assert.equal(
    fs.existsSync(path.join(root, ".vscodeignore")),
    false,
    "VSCE refuses a package that declares both a files property and a .vscodeignore",
  );
  const shipped = fs.readdirSync(path.join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`)
    .filter((relative) => !BINDING_DOCUMENTS.includes(relative))
    .sort();
  assert.deepEqual(
    packageJson.files.filter((entry) => entry.startsWith("docs/")).sort(),
    shipped,
    "the packaged documentation set drifted from the repository documentation set",
  );
});

test("screenshots of the packaged build never ship inside that build", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(
    packageJson.files.includes("media"),
    false,
    "packaging the whole media directory would ship the screenshots taken from the artifact it proves",
  );
  assert.equal(
    packageJson.files.some((entry) => entry.startsWith("media/screenshots")),
    false,
    "a screenshot of the packaged build ships inside that build, so adding one changes the artifact it proves",
  );
  const media = fs.readdirSync(path.join(root, "media"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "HEADER_PROMPT.md")
    .map((entry) => `media/${entry.name}`)
    .sort();
  assert.deepEqual(
    packageJson.files.filter((entry) => entry.startsWith("media/")).sort(),
    media,
    "the packaged media set drifted from the repository media set",
  );
  assert.equal(packageJson.files.includes("media/HEADER_PROMPT.md"), false);
});

test("candidate creation gates on identity only, never on evidence about the candidate", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts["vscode:prepublish"], /check:release-metadata:identity/u);
  assert.equal(
    /check:release-metadata:evidence|check:release-metadata\b(?!:)/u.test(
      packageJson.scripts["vscode:prepublish"],
    ),
    false,
    "candidate creation gates on evidence that only exists once the candidate does",
  );
  const verifyScript = fs.readFileSync(path.join(root, "scripts", "release-verify.mjs"), "utf8");
  assert.match(verifyScript, /--stage=all/u, "the publication gate does not run the full metadata stage");
  assert.match(verifyScript, /verifyVsix/u, "the publication gate does not verify the packaged bytes");
  const packageScript = fs.readFileSync(path.join(root, "scripts", "package.mjs"), "utf8");
  assert.equal(
    packageScript.includes("--stage=artifact") || packageScript.includes("--stage=all"),
    false,
    "packaging still runs an artifact-bound gate against an artifact it has just created",
  );
});

test("voiding a row keeps the descriptors needed to repeat the test", async () => {
  const { planDocumentBinding } = await load();
  const original = [
    "# Matrix",
    "",
    `Artifacts under test: Bachata VSIX \`${"c".repeat(64)}\`, Browser Bridge ZIP \`${"d".repeat(64)}\`.`,
    "",
    "| Extension | Provider | Provider version | OS | Checklist | Date | Artifact SHA-256 | Result | Known limitations |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    `| 0.6.12 | Codex app server | 1.0.0 | macOS | HUMAN_E2E | 2026-08-01 | \`${"c".repeat(64)}\` | pass | none |`,
    "",
  ].join("\n");
  const plan = planDocumentBinding({
    relative: "docs/COMPATIBILITY_MATRIX.md",
    original,
    artifacts,
  });
  assert.equal(plan.voided, 1);
  assert.match(
    plan.next,
    /\| 0\.6\.12 \| Codex app server \| 1\.0\.0 \| macOS \| HUMAN_E2E \| — \| — \| Not performed \| — \|/u,
  );
});

test("an unbindable recorded row refuses the whole binding instead of being rewritten", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bind-fixture-"));
  try {
    const script = path.join(root, "scripts", "bind-release-artifacts.mjs");
    const probe = [
      "import { planDocumentBinding } from " + JSON.stringify(pathToFileURL(path.join(root, "scripts", "lib", "bindReleaseArtifacts.mjs")).href) + ";",
      "const artifacts = { vsix: { label: 'Bachata VSIX', sha256: 'a'.repeat(64), version: '1' }, bridge: { label: 'Browser Bridge ZIP', sha256: 'b'.repeat(64), version: '1' } };",
      "const original = ['# R', '', 'Artifacts under test: Bachata VSIX `' + 'c'.repeat(64) + '`, Browser Bridge ZIP `' + 'd'.repeat(64) + '`.', '', '| Step | Date | Result | Notes |', '| --- | --- | --- | --- |', '| Install | 2026-08-01 | pass | none |', ''].join('\\n');",
      "const plan = planDocumentBinding({ relative: 'docs/PROVIDER_TERMS.md', original, artifacts });",
      "console.log(JSON.stringify({ unbindable: plan.unbindable.length, voided: plan.voided }));",
    ].join("\n");
    const probeFile = path.join(fixtureRoot, "probe.mjs");
    fs.writeFileSync(probeFile, probe, "utf8");
    const output = JSON.parse(execFileSync(process.execPath, [probeFile], { encoding: "utf8" }).trim());
    assert.equal(output.unbindable, 1, "a recorded row with no artifact hash was not reported");
    assert.equal(output.voided, 0);
    assert.equal(fs.existsSync(script), true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("the binder refuses to write when any recorded row cannot be bound", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "bind-release-artifacts.mjs"), "utf8");
  assert.match(
    source,
    /if \(problems\.length === 0 && unbindable\.length > 0\)/u,
    "unbindable evidence no longer refuses the binding",
  );
  assert.equal(
    source.indexOf("process.exit(1)") < source.indexOf("await bindDocuments("),
    true,
    "the binder can stage or write before it refuses",
  );
});

test("release verification fingerprints the artifact around every check", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "release-verify.mjs"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts["release:verify"], /release-verify\.mjs/u);
  assert.equal(
    packageJson.scripts["release:verify"].includes("&&"),
    false,
    "release:verify still chains two commands that can each read a different artifact",
  );
  assert.match(
    source,
    /createTrackedTemporaryDirectory/u,
    "release verification does not take a private snapshot",
  );
  assert.match(source, /writeFile\(artifact\.snapshot, artifact\.bytes/u);
  assert.match(source, /snapshot does not match the bytes that were read/u);
  assert.match(source, /--vsix=\$\{artifacts\[0\]\.snapshot\}/u, "the record check reads a different file than the byte check");
  assert.match(source, /verifyVsix\(artifacts\[0\]\.snapshot\)/u);
  assert.match(source, /snapshot changed during verification/u);
  assert.match(source, /the staged artifact changed while it ran/u);
});

test("release verification covers the Browser Bridge, not the VSIX alone", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "release-verify.mjs"), "utf8");
  assert.match(source, /Browser Bridge ZIP/u, "the Bridge is not part of the verified release set");
  assert.match(source, /--bridge=\$\{artifacts\[1\]\.snapshot\}/u);
  assert.match(source, /resolvePinnedBridgeArchive/u, "the Bridge is not resolved from the pinned version");
  const resolver = fs.readFileSync(path.join(root, "scripts", "lib", "releaseArtifacts.mjs"), "utf8");
  assert.match(
    resolver,
    /which was not found beside this repository/u,
    "a missing pinned Bridge does not fail resolution",
  );
  assert.match(
    resolver,
    /Remove the versions this release does not pin/u,
    "an unpinned Bridge version beside this repository is not refused",
  );
});

test("the packaged file set is derived from the manifest, not guessed", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "verify-vsix.mjs"), "utf8");
  assert.match(
    source,
    /const shippedSourceFiles = async \(manifest\)/u,
    "the verifier no longer derives its equivalence set from package.json files",
  );
  assert.equal(
    /repositoryFiles\("media"\)/u.test(source),
    false,
    "the verifier still recurses into media, which would demand the unpackaged screenshots",
  );
  assert.equal(
    /repositoryFiles\("docs"\)/u.test(source),
    false,
    "the verifier still recurses into docs, which would demand the unpackaged binding records",
  );
});

test("an actual screenshot never enters the verifier's equivalence set", async () => {
  const { shippedSourceFiles } = await import(
    pathToFileURL(path.join(root, "scripts", "verify-vsix.mjs")).href
  );
  const screenshot = path.join(root, "media", "screenshots", "verifier-fixture.png");
  const created = !fs.existsSync(screenshot);
  if (created) {
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    fs.writeFileSync(screenshot, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const shipped = await shippedSourceFiles(packageJson);
    assert.equal(
      shipped.some((relative) => relative.startsWith("media/screenshots/")),
      false,
      `a screenshot entered the equivalence set: ${shipped.filter((r) => r.startsWith("media/screenshots/")).join(", ")}`,
    );
    assert.equal(
      shipped.some((relative) => relative === "media/icon.png"),
      true,
      "packaged media dropped out of the equivalence set",
    );
    assert.equal(
      shipped.some((relative) => relative.startsWith("docs/")),
      true,
      "packaged documentation dropped out of the equivalence set",
    );
    assert.equal(
      shipped.some((relative) => relative.startsWith("dist/") || relative.startsWith("node_modules/")),
      false,
      "generated output entered the source equivalence set",
    );
  } finally {
    if (created) fs.rmSync(screenshot, { force: true });
  }
});

test("a terminal dual-artifact row missing one hash refuses the binding", async () => {
  const { planDocumentBinding } = await load();
  const dual = (bridgeCell) => [
    "# R",
    "",
    `Artifacts under test: Bachata VSIX \`${"a".repeat(64)}\`, Browser Bridge ZIP \`${"b".repeat(64)}\`.`,
    "",
    "| Provider | VSIX SHA-256 | Bridge SHA-256 | Terms reviewed |",
    "| --- | --- | --- | --- |",
    `| ChatGPT | \`${"a".repeat(64)}\` | ${bridgeCell} | Reviewed |`,
    "",
  ].join("\n");

  const partial = planDocumentBinding({
    relative: "docs/PROVIDER_TERMS.md",
    original: dual("—"),
    artifacts,
    schemas: {},
  });
  assert.equal(partial.voided, 0);
  assert.equal(partial.unbindable.length, 1, "a half-recorded dual-artifact row was accepted");
  assert.match(partial.unbindable[0], /Bridge SHA-256 is not a staged artifact hash/u);

  const complete = planDocumentBinding({
    relative: "docs/PROVIDER_TERMS.md",
    original: dual(`\`${"b".repeat(64)}\``),
    artifacts,
    schemas: {},
  });
  assert.deepEqual(complete.unbindable, []);
  assert.equal(complete.voided, 0);
});

test("the Browser Bridge is resolved from the pinned version, never by scanning", async () => {
  const { resolvePinnedBridgeArchive, pinnedBridgeRelease } = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "releaseArtifacts.mjs")).href
  );
  const pinned = await pinnedBridgeRelease(root);
  assert.equal(pinned.version, bridgeCompatibility.browserBridgeVersion);
  assert.equal(
    pinned.fileName,
    `${bridgeCompatibility.browserBridgePackage}-${bridgeCompatibility.browserBridgeVersion}.zip`,
  );

  ["scripts/release-verify.mjs", "scripts/bind-release-artifacts.mjs", "scripts/check-release-metadata.mjs"]
    .forEach((relative) => {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      assert.match(source, /resolvePinnedBridgeArchive/u, `${relative} does not resolve the pinned Bridge`);
      assert.equal(
        /startsWith\("bachata-browser-bridge-"\)/u.test(source),
        false,
        `${relative} still selects a Bridge by scanning siblings`,
      );
    });

  if (pinnedBridgeArchivePresent) {
    const resolved = await resolvePinnedBridgeArchive(root);
    assert.equal(path.basename(resolved.path), pinned.fileName);
  } else {
    await assert.rejects(
      resolvePinnedBridgeArchive(root),
      /was not found beside this repository/u,
      "an unstaged release archive was silently selected from another location",
    );
  }
});

test("the Browser Bridge archive is structurally verified, not only hashed", requiresPinnedBridgeArchive, async () => {
  const { verifyBridgeArchive, bridgeSourceRoot } = await import(
    pathToFileURL(path.join(root, "scripts", "verify-bridge.mjs")).href
  );
  const { resolvePinnedBridgeArchive } = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "releaseArtifacts.mjs")).href
  );
  const pinned = await resolvePinnedBridgeArchive(root);
  const result = await verifyBridgeArchive(pinned.path, pinned, {
    sourceRoot: await bridgeSourceRoot(pinned.path),
  });
  assert.ok(result.entries > 10, "the Bridge archive was not read");
  assert.equal(result.version, pinned.version);
  assert.match(result.digest, /^[0-9a-f]{64}$/u);

  await assert.rejects(
    verifyBridgeArchive(pinned.path, { ...pinned, version: "0.0.0" }, {
      sourceRoot: await bridgeSourceRoot(pinned.path),
    }),
    /declares version .*, but this release pins 0\.0\.0/u,
    "a Bridge whose manifest disagrees with the pinned version was accepted",
  );
  await assert.rejects(
    verifyBridgeArchive(pinned.path, pinned, {}),
    /build directory was not found/u,
    "a Bridge with no build to compare against was silently accepted",
  );

  const verifySource = fs.readFileSync(path.join(root, "scripts", "release-verify.mjs"), "utf8");
  assert.match(verifySource, /verifyBridgeArchive\(artifacts\[1\]\.snapshot, pinnedBridge, \{/u);
});

test("release verification never leaks its snapshot directory", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "release-verify.mjs"), "utf8");
  assert.equal(
    source.includes("process.exit("),
    false,
    "process.exit bypasses the cleanup that removes the artifact snapshots",
  );
  assert.match(source, /process\.exitCode = 1/u);
  assert.match(source, /if \(!cleanup\(\)\) \{/u, "a failed cleanup is not surfaced");
});

test("every temporary directory a release command takes is removed under one lifecycle", async () => {
  const {
    createTrackedTemporaryDirectory,
    removeEveryTrackedTemporaryDirectory,
    removeTrackedTemporaryDirectory,
    trackedTemporaryDirectories,
  } = await import(pathToFileURL(path.join(root, "scripts", "lib", "temporaryResources.mjs")).href);
  const first = await createTrackedTemporaryDirectory(path.join(os.tmpdir(), "bachata-tracked-a-"));
  const second = await createTrackedTemporaryDirectory(path.join(os.tmpdir(), "bachata-tracked-b-"));
  try {
    assert.deepEqual(trackedTemporaryDirectories().sort(), [first, second].sort());
    fs.writeFileSync(path.join(first, "payload"), "bytes");
    assert.equal(removeTrackedTemporaryDirectory(first), undefined);
    assert.equal(fs.existsSync(first), false);
    assert.deepEqual(trackedTemporaryDirectories(), [second]);
    assert.deepEqual(removeEveryTrackedTemporaryDirectory(), []);
    assert.equal(fs.existsSync(second), false);
    assert.deepEqual(trackedTemporaryDirectories(), []);
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test("packaged production dependencies are byte-checked before anything from the artifact runs", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "verify-vsix.mjs"), "utf8");
  const dependencyCheck = source.indexOf("production dependency closure does not match");
  const smoke = source.indexOf("verify-packaged-extension.cjs");
  assert.ok(dependencyCheck > 0, "packaged dependencies are not compared with this checkout");
  assert.ok(
    dependencyCheck < smoke,
    "the packaged extension is executed before its dependencies are verified",
  );
  assert.match(source, /extension\/node_modules\//u);
});

test("a record document cannot substitute, empty, or rename a required table", async () => {
  const { releaseMetadataFindings, RECORD_SCHEMAS } = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "releaseMetadata.mjs")).href
  );
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  const live = () => ({
    packageJson: JSON.parse(read("package.json")),
    artifacts: {
      vsix: { version: "0.6.12", sha256: "1".repeat(64) },
      bridge: { version: "0.6.7", sha256: "2".repeat(64) },
    },
    stage: "artifact",
    validationRecord: read("docs/RELEASE_VALIDATION_RECORD.md"),
    providerTerms: read("docs/PROVIDER_TERMS.md"),
    compatibilityMatrix: read("docs/COMPATIBILITY_MATRIX.md"),
  });

  const graphicalRows = [
    "| macOS | — | — | — | — | Not performed | — |",
    "| Linux | — | — | — | — | Not performed | — |",
    "| Windows | — | — | — | — | Not performed | — |",
  ].join("\n");
  assert.ok(
    live().validationRecord.includes(graphicalRows),
    "the graphical validation rows are not where this test expects them",
  );

  const substituted = live();
  substituted.validationRecord = substituted.validationRecord.replace(
    graphicalRows,
    `| Anything | — | \`${"1".repeat(64)}\` | 2026-08-01 | operator | pass | none |`,
  );
  assert.ok(
    releaseMetadataFindings(substituted).some((finding) => finding.includes("requires exactly")),
    "an unrelated one-row pass table replaced required graphical validation without a finding",
  );

  const emptied = live();
  emptied.validationRecord = emptied.validationRecord.replace(graphicalRows, "");
  assert.ok(
    releaseMetadataFindings(emptied).some((finding) => finding.includes("requires exactly")),
    "an empty record table was accepted",
  );

  const renamed = live();
  renamed.compatibilityMatrix = renamed.compatibilityMatrix.replace(
    "| Known limitations |",
    "| Notes |",
  );
  assert.ok(
    releaseMetadataFindings(renamed).some((finding) => finding.includes("declares columns")),
    "an altered header was accepted",
  );

  Object.values(RECORD_SCHEMAS).forEach((tables) => {
    tables.forEach((table) => {
      assert.ok(Array.isArray(table.headers) && table.headers.length > 0);
      assert.ok(Array.isArray(table.rows) && table.rows.length > 0);
    });
  });
});

test("the binder refuses a substituted record document before it plans any write", async () => {
  const { planDocumentBinding } = await load();
  const original = fs.readFileSync(path.join(root, "docs", "COMPATIBILITY_MATRIX.md"), "utf8")
    .replace("| Known limitations |", "| Notes |");
  const plan = planDocumentBinding({
    relative: "docs/COMPATIBILITY_MATRIX.md",
    original,
    artifacts: {
      vsix: { label: "Bachata VSIX", sha256: "1".repeat(64), version: "0.6.12" },
      bridge: { label: "Browser Bridge ZIP", sha256: "2".repeat(64), version: "0.6.7" },
    },
  });
  assert.ok(
    plan.problems.some((problem) => problem.includes("declares columns")),
    "the binder rebound a document whose schema no longer matches this release",
  );
});

test("the Browser Bridge archive is a closed package compared with its build", requiresPinnedBridgeArchive, async () => {
  const { verifyBridgeArchive, bridgeSourceRoot, MAXIMUM_BRIDGE_ENTRIES } = await import(
    pathToFileURL(path.join(root, "scripts", "verify-bridge.mjs")).href
  );
  const { resolvePinnedBridgeArchive } = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "releaseArtifacts.mjs")).href
  );
  const pinned = await resolvePinnedBridgeArchive(root);
  const sourceRoot = await bridgeSourceRoot(pinned.path);
  assert.ok(sourceRoot, "the Bridge build directory was not found, so nothing was compared");
  const result = await verifyBridgeArchive(pinned.path, pinned, { sourceRoot });
  assert.equal(
    result.compared,
    result.entries,
    "the archive and the build it was packaged from were not compared entry for entry",
  );
  assert.ok(result.declaredFiles.includes("popup/index.html"), "the popup is not verified");
  assert.ok(MAXIMUM_BRIDGE_ENTRIES > 0);

  const source = fs.readFileSync(path.join(root, "scripts", "verify-bridge.mjs"), "utf8");
  assert.match(source, /MAXIMUM_BRIDGE_ENTRY_BYTES/u, "there is no per-entry size bound");
  assert.match(source, /MAXIMUM_BRIDGE_TOTAL_BYTES/u, "there is no total uncompressed bound");
  assert.match(source, /streams more bytes than it declares/u, "entries are not bounded while streaming");
  assert.equal(
    source.includes("Buffer.concat(chunks)"),
    false,
    "whole entries are still buffered before they are bounded",
  );
});

test("release verification cleans up even when it is interrupted", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "release-verify.mjs"), "utf8");
  ["SIGINT", "SIGTERM", "SIGHUP"].forEach((signal) => {
    assert.ok(source.includes(signal), `${signal} does not trigger snapshot cleanup`);
  });
  assert.match(source, /process\.on\("exit", \(\) => \{/u);
  const vsixSource = fs.readFileSync(path.join(root, "scripts", "verify-vsix.mjs"), "utf8");
  assert.match(
    vsixSource,
    /createTrackedTemporaryDirectory\(path\.join\(os\.tmpdir\(\), "bachata-vsix-"\)\)/u,
    "the VSIX extraction directory is outside the shared cleanup lifecycle",
  );
});

test("an artifact override is validated against the pinned release", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "check-release-metadata.mjs"), "utf8");
  assert.match(source, /--bridge=\$\{bridgeOverride\} declares version/u);
  assert.match(source, /is not named \$\{pinnedBridge\.fileName\}/u);
  assert.match(source, /--vsix=\$\{vsixOverride\} is not named/u);
});

test("the production dependency closure is compared in both directions", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "verify-vsix.mjs"), "utf8");
  assert.match(source, /is installed here but missing from the VSIX/u);
  assert.match(source, /is packaged but not installed in this checkout/u);
  assert.match(source, /is a symbolic link in this checkout/u);
  assert.match(source, /packagedDependencyPackages/u);
});

test("a record row cannot be substituted while keeping its first cell", async () => {
  const { releaseMetadataFindings } = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "releaseMetadata.mjs")).href
  );
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  const live = () => ({
    packageJson: JSON.parse(read("package.json")),
    artifacts: {
      vsix: { version: "0.6.12", sha256: "1".repeat(64) },
      bridge: { version: "0.6.7", sha256: "2".repeat(64) },
    },
    stage: "artifact",
    validationRecord: read("docs/RELEASE_VALIDATION_RECORD.md"),
    providerTerms: read("docs/PROVIDER_TERMS.md"),
    compatibilityMatrix: read("docs/COMPATIBILITY_MATRIX.md"),
  });

  const invented = live();
  invented.compatibilityMatrix = invented.compatibilityMatrix.replace(
    "Codex app server",
    "Invented provider",
  );
  assert.ok(
    releaseMetadataFindings(invented).some((finding) =>
      finding.includes("not the record this release requires")),
    "a compatibility row was replaced with an invented provider without a finding",
  );

  const easier = live();
  easier.compatibilityMatrix = easier.compatibilityMatrix.replace(
    "HUMAN_E2E + LIVE_SMOKE_TEST",
    "Something easier",
  );
  assert.ok(
    releaseMetadataFindings(easier).some((finding) =>
      finding.includes("not the record this release requires")),
    "a row's required checklist was swapped without a finding",
  );

  const binder = await load();
  const plan = binder.planDocumentBinding({
    relative: "docs/COMPATIBILITY_MATRIX.md",
    original: invented.compatibilityMatrix,
    artifacts: {
      vsix: { label: "Bachata VSIX", sha256: "1".repeat(64), version: "0.6.12" },
      bridge: { label: "Browser Bridge ZIP", sha256: "2".repeat(64), version: "0.6.7" },
    },
  });
  assert.ok(
    plan.problems.some((problem) => problem.includes("not the record this release requires")),
    "the binder rebound a document whose rows were substituted",
  );
});

test("the packaged dependency set is derived from the lockfile, not from the artifact", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "verify-vsix.mjs"), "utf8");
  assert.match(source, /lockedProductionPackages/u);
  assert.match(source, /package-lock\.json/u);
  assert.match(source, /does not match the .*-package locked closure/u);
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const production = Object.entries(lockfile.packages ?? {})
    .filter(([name, entry]) => name.startsWith("node_modules/") &&
      entry?.dev !== true && entry?.optional !== true);
  assert.ok(production.length > 0, "the lockfile declares no production closure");
});

test("archive readers bound records, entries, and streamed bytes", () => {
  const zipEntry = fs.readFileSync(path.join(root, "scripts", "lib", "zipEntry.mjs"), "utf8");
  assert.match(zipEntry, /MAXIMUM_MANIFEST_RECORDS/u);
  assert.match(zipEntry, /MAXIMUM_MANIFEST_BYTES/u);
  assert.match(zipEntry, /streams more than/u);
  assert.match(zipEntry, /duplicate entry/u);

  const vsix = fs.readFileSync(path.join(root, "scripts", "verify-vsix.mjs"), "utf8");
  ["MAXIMUM_VSIX_RECORDS", "MAXIMUM_VSIX_ENTRY_BYTES", "MAXIMUM_VSIX_TOTAL_BYTES", "MAXIMUM_VSIX_ARCHIVE_BYTES"]
    .forEach((marker) => assert.match(vsix, new RegExp(marker, "u"), `${marker} is missing`));

  const bridge = fs.readFileSync(path.join(root, "scripts", "verify-bridge.mjs"), "utf8");
  assert.match(bridge, /records \+= 1/u, "directory records are not counted");
  assert.match(bridge, /seen\.has\(name\)/u, "duplicate directory records are not refused");
});

test("every literal manifest file reference is validated", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "verify-bridge.mjs"), "utf8");
  ["content_scripts", "script.css", "options_ui", "options_page", "side_panel", "devtools_page",
    "chrome_url_overrides", "sandbox", "declarative_net_request", "web_accessible_resources"]
    .forEach((field) => {
      assert.match(source, new RegExp(field.replace(/[.[\]]/gu, "\\$&"), "u"), `${field} references are not validated`);
    });
});


const { execFileSync, spawnSync } = require("node:child_process");
const os = require("node:os");
const zlib = require("node:zlib");

const zipArchive = (entries) => {
  const files = [];
  const central = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : require("node:zlib").crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    files.push(local, nameBytes, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, centralBuffer, end]);
};

test("normalized path collisions are refused before extraction", async () => {
  const { verifyVsix } = await import(pathToFileURL(path.join(root, "scripts", "verify-vsix.mjs")).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-vsix-collision-"));
  try {
    const archive = path.join(directory, "collision.vsix");
    fs.writeFileSync(archive, zipArchive([
      ["extension/package.json", "{}"],
      ["extension//package.json", "{}"],
    ]));
    await assert.rejects(
      verifyVsix(archive),
      /empty path segment|collide once normalized/u,
      "two entries that extract to the same target were accepted",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unexpected directory record fails the Bridge closure comparison", async () => {
  const { verifyBridgeArchive } = await import(pathToFileURL(path.join(root, "scripts", "verify-bridge.mjs")).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bridge-closure-"));
  try {
    const source = path.join(directory, "dist");
    fs.mkdirSync(source);
    const manifest = JSON.stringify({ manifest_version: 3, version: "9.9.9", name: "x" });
    fs.writeFileSync(path.join(source, "manifest.json"), manifest);
    fs.writeFileSync(path.join(source, "LICENSE"), "l");
    fs.writeFileSync(path.join(source, "THIRD_PARTY_NOTICES.txt"), "n");
    fs.mkdirSync(path.join(source, "background"));
    fs.writeFileSync(path.join(source, "background", "index.js"), "b");
    fs.mkdirSync(path.join(source, "protocol"));
    fs.writeFileSync(path.join(source, "protocol", "types.js"), "t");

    const entries = [
      ["manifest.json", manifest],
      ["LICENSE", "l"],
      ["THIRD_PARTY_NOTICES.txt", "n"],
      ["background/index.js", "b"],
      ["protocol/types.js", "t"],
    ];
    const clean = path.join(directory, "clean.zip");
    fs.writeFileSync(clean, zipArchive(entries));
    const pinned = { version: "9.9.9", fileName: "clean.zip" };
    const ok = await verifyBridgeArchive(clean, pinned, { sourceRoot: source });
    assert.equal(ok.compared, ok.entries);

    const extra = path.join(directory, "extra.zip");
    fs.writeFileSync(extra, zipArchive([...entries, ["unexpected/", ""]]));
    await assert.rejects(
      verifyBridgeArchive(extra, pinned, { sourceRoot: source }),
      /not the exact packaged build/u,
      "an unexpected directory record passed the closure comparison",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing managed schema fails Bridge verification", async () => {
  const { verifyBridgeArchive } = await import(pathToFileURL(path.join(root, "scripts", "verify-bridge.mjs")).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bridge-managed-"));
  try {
    const manifest = JSON.stringify({
      manifest_version: 3,
      version: "9.9.9",
      name: "x",
      storage: { managed_schema: "schema.json" },
    });
    const archive = path.join(directory, "managed.zip");
    fs.writeFileSync(archive, zipArchive([
      ["manifest.json", manifest],
      ["LICENSE", "l"],
      ["THIRD_PARTY_NOTICES.txt", "n"],
      ["background/index.js", "b"],
      ["protocol/types.js", "t"],
    ]));
    await assert.rejects(
      verifyBridgeArchive(archive, { version: "9.9.9" }, { requireSource: false }),
      /declares files the archive does not carry: schema\.json/u,
      "a manifest that declares a managed schema the archive lacks was accepted",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("two copies of the pinned Bridge are refused even when identical", async () => {
  const { resolvePinnedBridgeArchive } = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "releaseArtifacts.mjs")).href
  );
  const pinned = JSON.parse(
    fs.readFileSync(path.join(root, "protocol", "browser-bridge.compatibility.json"), "utf8"),
  );
  const fileName = `${pinned.browserBridgePackage}-${pinned.browserBridgeVersion}.zip`;
  const source = path.join(root, "..", `${pinned.browserBridgePackage}-${pinned.browserBridgeVersion}`, fileName);
  if (!fs.existsSync(source)) return;
  const duplicate = path.join(root, fileName);
  fs.copyFileSync(source, duplicate);
  try {
    await assert.rejects(
      resolvePinnedBridgeArchive(root),
      /copies/u,
      "two identical copies of the pinned Bridge were accepted",
    );
  } finally {
    fs.rmSync(duplicate, { force: true });
  }
  const resolved = await resolvePinnedBridgeArchive(root);
  assert.equal(path.basename(resolved.path), fileName);
});

test("interrupting release verification removes every temporary directory it took", () => {
  const prefixes = ["bachata-release-verify-", "bachata-vsix-"];
  const before = fs.readdirSync(os.tmpdir())
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
  const child = spawnSync(process.execPath, [
    "-e",
    [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, [${JSON.stringify(path.join(root, "scripts", "release-verify.mjs"))}], { cwd: ${JSON.stringify(root)}, stdio: 'ignore' });`,
      "setTimeout(() => { child.kill('SIGINT'); }, 1500);",
      "child.on('exit', () => process.exit(0));",
    ].join("\n"),
  ], { encoding: "utf8", timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr ?? "");
  const after = fs.readdirSync(os.tmpdir())
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
  assert.deepEqual(
    after.filter((name) => !before.includes(name)),
    [],
    "an interrupted verification left an artifact snapshot or a VSIX extraction behind",
  );
});

test("the binder script refuses to run while a lock is held and leaves no staging file", requiresPinnedBridgeArchive, async () => {
  const { planDocumentBinding } = await load();
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const artifactSet = {
    vsix: { label: "Bachata VSIX", sha256: "1".repeat(64), version },
    bridge: { label: "Browser Bridge ZIP", sha256: "2".repeat(64), version: "0.6.7" },
  };
  const original = [
    "# R",
    "",
    `Artifacts under test: Bachata VSIX \`${"9".repeat(64)}\`, Browser Bridge ZIP \`${"8".repeat(64)}\`.`,
    "",
  ].join("\n");
  const plan = planDocumentBinding({
    relative: "docs/RELEASE_VERDICT.md",
    original,
    artifacts: artifactSet,
    schemas: {},
  });
  assert.notEqual(plan.next, original, "the binding line was not rewritten");
  assert.deepEqual(plan.problems, []);

  const vsixPath = path.join(root, `bachata-vscode-${version}.vsix`);
  const vsixCreated = !fs.existsSync(vsixPath);
  const lock = path.join(root, "docs", ".bachata-bind.lock");
  try {
    if (vsixCreated) {
      fs.writeFileSync(vsixPath, zipArchive([
        ["extension/package.json", JSON.stringify({ version })],
      ]));
    }
    fs.writeFileSync(lock, "held");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "bind-release-artifacts.mjs")],
      { cwd: root, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.status, 1, "a held lock did not stop the binder");
    assert.match(result.stderr, /holds/u);
  } finally {
    fs.rmSync(lock, { force: true });
    if (vsixCreated) fs.rmSync(vsixPath, { force: true });
  }
  assert.deepEqual(
    fs.readdirSync(path.join(root, "docs")).filter((name) => name.includes(".bachata-bind")),
    [],
    "the binder left staging files behind",
  );
});

const releaseArtifacts = () => import(
  pathToFileURL(path.join(root, "scripts", "lib", "releaseArtifacts.mjs")).href
);

test("a release artifact replaced by a symbolic link is refused, not read", async () => {
  const { openPinnedArtifact } = await releaseArtifacts();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-artifact-link-"));
  try {
    const real = path.join(directory, "real.zip");
    fs.writeFileSync(real, zipArchive([["manifest.json", "{\"version\":\"1.0.0\"}"]]));
    const link = path.join(directory, "candidate.zip");
    fs.symlinkSync(real, link);
    await assert.rejects(openPinnedArtifact(link), /symbolic link/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const isolatedArtifactReader = (filesystem, platform = process.platform) => {
  const vm = require("node:vm");
  const context = vm.createContext({
    ...filesystem,
    path: platform === "win32" ? path.win32 : path,
    process: { platform },
    Buffer,
  });
  const loadFunction = (name, result) => {
    const source = fs.readFileSync(path.join(root, "scripts", "lib", name), "utf8")
      .replace(/^import .*;$/gmu, "")
      .replace(/^export /gmu, "");
    return vm.compileFunction(`${source}\nreturn ${result};`, [], { parsingContext: context })();
  };
  context.openVerifiedRegularFile = loadFunction("verifiedRegularFile.mjs", "openVerifiedRegularFile");
  return loadFunction("releaseArtifacts.mjs", "openPinnedArtifact");
};

test("artifact reads verify Windows root volume before reading and close both handles", async () => {
  const filesystem = require("node:fs/promises");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-artifact-volume-"));
  const candidate = path.join(directory, "artifact.zip");
  fs.writeFileSync(candidate, "artifact bytes");
  try {
    for (const wrongVolume of [false, true]) {
      let sourceReads = 0;
      let sourceCloses = 0;
      let rootCloses = 0;
      let rootReads = 0;
      const windowsPath = "C:\\workspace\\artifact.zip";
      const inode = 0x20_0000_0000_0001n;
      const io = {
        ...filesystem,
        lstat: async (file, options) => {
          assert.equal(file, windowsPath);
          assert.equal(options.bigint, true);
          const details = await filesystem.lstat(candidate, options);
          return { ...details, dev: 0n, ino: inode, isFile: () => true, isSymbolicLink: () => false };
        },
        realpath: async (file) => { assert.equal(file, windowsPath); return windowsPath; },
        open: async (file, flags) => {
          if (file === "C:\\") {
            const anchor = await filesystem.open(directory, filesystem.constants.O_RDONLY);
            return {
              stat: async (options) => {
                const details = await anchor.stat(options);
                return { ...details, dev: 42n, isDirectory: () => details.isDirectory() };
              },
              read: async () => { rootReads += 1; throw new Error("root bytes must not be read"); },
              close: async () => { rootCloses += 1; await anchor.close(); },
            };
          }
          assert.equal(file, windowsPath);
          const handle = await filesystem.open(candidate, flags);
          return {
            stat: async (options) => {
              const details = await handle.stat(options);
              return { ...details, dev: wrongVolume ? 43n : 42n, ino: inode, isFile: () => details.isFile() };
            },
            read: async (...args) => { sourceReads += 1; return handle.read(...args); },
            close: async () => { sourceCloses += 1; await handle.close(); },
          };
        },
      };
      const operation = isolatedArtifactReader(io, "win32")(windowsPath);
      if (wrongVolume) await assert.rejects(operation, /changed while it was being opened/u);
      else assert.equal((await operation).bytes.toString(), "artifact bytes");
      assert.equal(sourceReads, wrongVolume ? 0 : 1);
      assert.equal(sourceCloses, 1);
      assert.equal(rootCloses, 1);
      assert.equal(rootReads, 0);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact open-boundary file and directory replacements are refused before reading", async () => {
  const filesystem = require("node:fs/promises");
  for (const replaceDirectory of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-artifact-race-"));
    const parent = path.join(directory, "source");
    const outside = path.join(directory, "outside");
    fs.mkdirSync(parent);
    fs.mkdirSync(outside);
    const candidate = path.join(parent, "candidate.zip");
    const secret = path.join(outside, "candidate.zip");
    fs.writeFileSync(candidate, "safe");
    fs.writeFileSync(secret, "secret");
    let reads = 0;
    let closes = 0;
    let swapped = false;
    try {
      const io = {
        ...filesystem,
        open: async (file, flags) => {
          if (file !== candidate) return filesystem.open(file, flags);
          if (replaceDirectory) {
            fs.renameSync(parent, `${parent}-original`);
            fs.symlinkSync(outside, parent, "junction");
          } else {
            fs.unlinkSync(candidate);
            fs.symlinkSync(secret, candidate);
          }
          swapped = true;
          const handle = await filesystem.open(file, flags & ~(filesystem.constants.O_NOFOLLOW ?? 0));
          return {
            stat: (options) => handle.stat(options),
            read: async (...args) => { reads += 1; return handle.read(...args); },
            close: async () => { closes += 1; await handle.close(); },
          };
        },
      };
      await assert.rejects(isolatedArtifactReader(io)(candidate), replaceDirectory
        ? /changed while it was being opened/u : /symbolic link/u);
      assert.equal(swapped, true);
      assert.equal(reads, 0);
      assert.equal(closes, 1);
      assert.equal(fs.readFileSync(secret, "utf8"), "secret");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a release artifact above its own descriptor limit is refused before any allocation", async () => {
  const { openPinnedArtifact, BRIDGE_ARTIFACT_LIMITS } = await releaseArtifacts();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-artifact-limit-"));
  try {
    const candidate = path.join(directory, "candidate.zip");
    fs.writeFileSync(candidate, Buffer.alloc(4096));
    assert.equal(BRIDGE_ARTIFACT_LIMITS.maximumBytes, 64 * 1_048_576);
    await assert.rejects(
      openPinnedArtifact(candidate, { maximumBytes: 1024 }),
      /above the 1024-byte limit/u,
    );
    const opened = await openPinnedArtifact(candidate, { maximumBytes: 8192 });
    assert.equal(opened.size, 4096);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a same-size in-place rewrite during the read is refused", async () => {
  const { openPinnedArtifact } = await releaseArtifacts();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-artifact-mutate-"));
  const candidate = path.join(directory, "candidate.zip");
  const size = 8 * 1_048_576;
  fs.writeFileSync(candidate, Buffer.alloc(size, 0x41));
  const writer = fs.openSync(candidate, "r+");
  let mutating = true;
  let counter = 0;
  const mutate = () => {
    if (!mutating) return;
    counter += 1;
    fs.writeSync(writer, Buffer.alloc(1024, counter % 251), 0, 1024, 0);
    setImmediate(mutate);
  };
  try {
    setImmediate(mutate);
    await assert.rejects(
      openPinnedArtifact(candidate, { maximumBytes: 16 * 1_048_576 }),
      /changed size while it was being read|was replaced while it was being read|was rewritten in place while it was being read/u,
      "a same-size in-place rewrite during the read was accepted",
    );
  } finally {
    mutating = false;
    fs.closeSync(writer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a manifest-first archive is still validated to the end of its central directory", async () => {
  const { readZipEntryFromBuffer } = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "zipEntry.mjs")).href
  );
  const archive = zipArchive([
    ["manifest.json", "{\"version\":\"1.0.0\"}"],
    ["payload.bin", Buffer.alloc(4096, 7)],
  ]);
  const accepted = await readZipEntryFromBuffer(archive, "candidate.zip", "manifest.json", {
    maximumDeclaredBytes: 1_048_576,
  });
  assert.equal(JSON.parse(accepted.toString("utf8")).version, "1.0.0");

  await assert.rejects(
    readZipEntryFromBuffer(archive, "candidate.zip", "manifest.json", {
      maximumDeclaredBytes: 2048,
    }),
    /declares more than 2048 uncompressed bytes/u,
    "a record declared after the requested manifest escaped the declared-byte bound",
  );
  await assert.rejects(
    readZipEntryFromBuffer(archive, "candidate.zip", "manifest.json", { maximumRecords: 1 }),
    /declares more than 1 records/u,
    "a record declared after the requested manifest escaped the record bound",
  );
  await assert.rejects(
    readZipEntryFromBuffer(
      zipArchive([
        ["manifest.json", "{\"version\":\"1.0.0\"}"],
        ["manifest.json", "{\"version\":\"9.9.9\"}"],
      ]),
      "candidate.zip",
      "manifest.json",
    ),
    /duplicate entry: manifest\.json/u,
    "a duplicate declared after the requested manifest was accepted",
  );
});

test("a Bridge directory record carrying data is refused even when its name matches the build", async () => {
  const { verifyBridgeArchive } = await import(
    pathToFileURL(path.join(root, "scripts", "verify-bridge.mjs")).href
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bridge-directory-"));
  try {
    const sourceRoot = path.join(directory, "dist");
    fs.mkdirSync(path.join(sourceRoot, "background"), { recursive: true });
    const manifest = JSON.stringify({
      version: "0.6.7",
      manifest_version: 3,
      background: { service_worker: "background/worker.js" },
    });
    fs.writeFileSync(path.join(sourceRoot, "manifest.json"), manifest);
    fs.writeFileSync(path.join(sourceRoot, "background", "worker.js"), "export {};\n");

    const archive = path.join(directory, "bridge.zip");
    fs.writeFileSync(archive, zipArchive([
      ["manifest.json", manifest],
      ["background/", "UNVERIFIED-DIRECTORY-DATA"],
      ["background/worker.js", "export {};\n"],
    ]));
    await assert.rejects(
      verifyBridgeArchive(archive, { version: "0.6.7" }, { sourceRoot }),
      /directory record background\/ declares/u,
      "a directory record carrying a payload skipped size, stream, and digest validation",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Bridge entries that collide once normalized are refused", async () => {
  const { verifyBridgeArchive } = await import(
    pathToFileURL(path.join(root, "scripts", "verify-bridge.mjs")).href
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bridge-collision-"));
  try {
    const archive = path.join(directory, "bridge.zip");
    fs.writeFileSync(archive, zipArchive([
      ["manifest.json", "{\"version\":\"0.6.7\",\"manifest_version\":3}"],
      ["Manifest.JSON", "{\"version\":\"9.9.9\"}"],
    ]));
    await assert.rejects(
      verifyBridgeArchive(archive, { version: "0.6.7" }, { requireSource: false }),
      /collide once normalized/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("VSIX entries that are Windows filesystem aliases are refused", async () => {
  const { verifyVsix } = await import(pathToFileURL(path.join(root, "scripts", "verify-vsix.mjs")).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-vsix-alias-"));
  try {
    for (const name of [
      "extension/package.json.",
      "extension/package.json ",
      "extension/nul.json",
      "extension/com1.txt",
      "extension/package.json:stream",
      "extension/nul. ",
    ]) {
      const archive = path.join(directory, "alias.vsix");
      fs.writeFileSync(archive, zipArchive([[name, "{}"]]));
      await assert.rejects(
        verifyVsix(archive),
        /ambiguous on Windows/u,
        `${name} was accepted as a distinct packaged path`,
      );
      fs.rmSync(archive, { force: true });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("npm platform predicates apply exclusions before allowlists and honour libc", async () => {
  const { packagePlatformSatisfied } = await import(
    pathToFileURL(path.join(root, "scripts", "verify-vsix.mjs")).href
  );
  const darwin = { platform: "darwin", arch: "arm64", libc: "glibc" };
  const linuxMusl = { platform: "linux", arch: "x64", libc: "musl" };
  const linuxGlibc = { platform: "linux", arch: "x64", libc: "glibc" };

  assert.equal(
    packagePlatformSatisfied({ os: ["!win32", "!darwin"] }, darwin),
    false,
    "a negated os list accepted the platform it excludes",
  );
  assert.equal(packagePlatformSatisfied({ os: ["!win32"] }, darwin), true);
  assert.equal(packagePlatformSatisfied({ os: ["darwin", "!darwin"] }, darwin), false);
  assert.equal(packagePlatformSatisfied({ cpu: ["!arm64"] }, darwin), false);
  assert.equal(packagePlatformSatisfied({ libc: ["glibc"] }, linuxMusl), false);
  assert.equal(packagePlatformSatisfied({ libc: ["glibc"] }, linuxGlibc), true);
  assert.equal(
    packagePlatformSatisfied({ libc: ["glibc"] }, darwin),
    true,
    "libc was applied off Linux, where npm does not evaluate it",
  );
  assert.equal(packagePlatformSatisfied({}, darwin), true);
  assert.equal(packagePlatformSatisfied(undefined, darwin), true);
});

const bindingTransaction = () => import(
  pathToFileURL(path.join(root, "scripts", "lib", "documentBindingTransaction.mjs")).href
);

const bindingFixture = (documents) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bind-transaction-"));
  const plans = documents.map(({ name, original, next, mode = 0o644 }) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, original, "utf8");
    fs.chmodSync(file, mode);
    return { relative: `docs/${name}`, file, original, next };
  });
  return { directory, plans };
};

const bindingResidue = (directory) =>
  fs.readdirSync(directory).filter((name) => name.includes(".bachata-bind")).sort();

test("a successful binding rewrites every document and keeps its mode", async () => {
  const { bindDocuments } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n", mode: 0o644 },
    { name: "two.md", original: "two before\n", next: "two after\n", mode: 0o640 },
  ]);
  const originalModes = plans.map(({ file }) => fs.statSync(file).mode & 0o777);
  try {
    const outcome = await bindDocuments({ docsDirectory: directory, plans });
    assert.equal(outcome.status, "bound");
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one after\n");
    assert.equal(fs.readFileSync(plans[1].file, "utf8"), "two after\n");
    assert.deepEqual(plans.map(({ file }) => fs.statSync(file).mode & 0o777), originalModes, "staging mode replaced the document mode");
    assert.deepEqual(bindingResidue(directory), [], "the binder left staging or backup files behind");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// EX-G6-15. Recovery is a mutation: it replays a journal and restores the documents that journal
// names. Running it before taking the lock meant a competing binder that was mid transaction —
// holding the lock, its journal on disk — had its writes rolled back by a newcomer that then
// discovered the lock was held and refused. The refusal was reported politely; the damage was
// already done.
test("a binder that finds the lock held does not touch the running transaction", async () => {
  const { bindDocuments, JOURNAL_NAME } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n", mode: 0o644 },
  ]);
  const lock = path.join(directory, ".bachata-bind.lock");
  const journal = path.join(directory, JOURNAL_NAME);
  const backup = path.join(directory, "one.md.live.bachata-bind-backup");
  try {
    // A live binder: it holds the lock, has written its backup, and its journal says how to put
    // the document back if it dies.
    fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid })}\n`);
    fs.writeFileSync(backup, "one before\n");
    fs.writeFileSync(plans[0].file, "one mid-transaction\n");
    fs.writeFileSync(journal, JSON.stringify({
      version: 1,
      entries: [{ relative: "one.md", file: plans[0].file, backup, committed: false }],
    }));

    const outcome = await bindDocuments({ docsDirectory: directory, plans });
    assert.equal(outcome.status, "blocked");
    assert.ok(
      outcome.reasons.some((reason) => /holds/u.test(reason)),
      `expected a held-lock refusal, got ${JSON.stringify(outcome.reasons)}`,
    );
    assert.deepEqual(outcome.recovered, [], "the refusal reported recovering another run's work");
    assert.equal(
      fs.readFileSync(plans[0].file, "utf8"),
      "one mid-transaction\n",
      "a refused binder rolled back the transaction that still holds the lock",
    );
    assert.equal(fs.existsSync(journal), true, "the running transaction's journal was consumed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a staging failure restores every document and leaves no orphan", async () => {
  const { bindDocuments } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
    { name: "two.md", original: "two before\n", next: "two after\n" },
  ]);
  try {
    const outcome = await bindDocuments({
      docsDirectory: directory,
      plans,
      hooks: {
        beforeStage: (record) => {
          if (record.relative === "docs/two.md") throw new Error("staging refused");
        },
      },
    });
    assert.equal(outcome.status, "rolled-back");
    assert.match(String(outcome.error?.message), /staging refused/u);
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one before\n");
    assert.equal(fs.readFileSync(plans[1].file, "utf8"), "two before\n");
    assert.deepEqual(bindingResidue(directory), [], "a partial staging failure left an orphan");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a rename failure restores every already-committed document with its mode", async () => {
  const { bindDocuments } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n", mode: 0o644 },
    { name: "two.md", original: "two before\n", next: "two after\n", mode: 0o600 },
  ]);
  const originalModes = plans.map(({ file }) => fs.statSync(file).mode & 0o777);
  try {
    const outcome = await bindDocuments({
      docsDirectory: directory,
      plans,
      hooks: {
        beforeRename: (record) => {
          if (record.relative === "docs/two.md") throw new Error("rename refused");
        },
      },
    });
    assert.equal(outcome.status, "rolled-back");
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one before\n", "a committed document was not restored");
    assert.equal(fs.readFileSync(plans[1].file, "utf8"), "two before\n");
    assert.deepEqual(plans.map(({ file }) => fs.statSync(file).mode & 0o777), originalModes, "the restored document lost its mode");
    assert.deepEqual(bindingResidue(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a document edited after staging is never overwritten by its staged content", async () => {
  const { bindDocuments } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
  ]);
  try {
    const outcome = await bindDocuments({
      docsDirectory: directory,
      plans,
      hooks: {
        beforeRename: () => {
          fs.writeFileSync(plans[0].file, "edited by hand\n", "utf8");
        },
      },
    });
    assert.equal(outcome.status, "rolled-back");
    assert.match(String(outcome.error?.message), /changed while this binding was being staged/u);
    assert.equal(
      fs.readFileSync(plans[0].file, "utf8"),
      "edited by hand\n",
      "a concurrent edit was overwritten by staged content",
    );
    assert.deepEqual(bindingResidue(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a document replaced by a symbolic link is never written through", async () => {
  const { bindDocuments } = await bindingTransaction();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bind-outside-"));
  const target = path.join(outside, "external.md");
  fs.writeFileSync(target, "one before\n", "utf8");
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
  ]);
  try {
    fs.rmSync(plans[0].file);
    fs.symlinkSync(target, plans[0].file);
    const outcome = await bindDocuments({ docsDirectory: directory, plans });
    assert.equal(outcome.status, "rolled-back");
    assert.equal(
      fs.readFileSync(target, "utf8"),
      "one before\n",
      "the binder wrote through a replacement symbolic link",
    );
    assert.deepEqual(bindingResidue(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a lock held by a live process refuses the binding, and an unreadable lock refuses too", async () => {
  const { bindDocuments, LOCK_NAME } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
  ]);
  try {
    const lock = path.join(directory, LOCK_NAME);
    fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
    const live = await bindDocuments({ docsDirectory: directory, plans });
    assert.equal(live.status, "blocked");
    assert.match(live.reasons.join(" "), /holds/u);
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one before\n");

    fs.writeFileSync(lock, "held", "utf8");
    const unreadable = await bindDocuments({ docsDirectory: directory, plans });
    assert.equal(unreadable.status, "blocked", "an unreadable lock was cleared instead of refusing");
    assert.match(unreadable.reasons.join(" "), /names no process/u);
    assert.equal(fs.existsSync(lock), true, "an unreadable lock was removed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a lock whose owner is gone is recovered and the binding proceeds", async () => {
  const { bindDocuments, LOCK_NAME } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
  ]);
  try {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(dead.status, 0);
    const stalePid = dead.pid + 1_000_000;
    fs.writeFileSync(
      path.join(directory, LOCK_NAME),
      `${JSON.stringify({ pid: stalePid })}\n`,
      "utf8",
    );
    const outcome = await bindDocuments({ docsDirectory: directory, plans });
    assert.equal(outcome.status, "bound", "a lock left by a dead process blocked the binding forever");
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one after\n");
    assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), false, "the binder left a stale lock");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// EX-A5-R16. Reclaiming an abandoned lock is two steps — read the owner, judge it gone, remove
// the lock — and the lock could change hands between them. The delayed reclaimer then deleted a
// live binder's lock and a third binder walked in on a running transaction, which journal
// recovery would afterwards roll back. The lock is now a link to the holder's own proof, and a
// reclaimer may only retire the exact instance it judged.
test("a reclaimer acting on a stale judgement never vacates a live binder's lock", async () => {
  const { acquireLockInstance, retireLockInstance, heldLockOwner, LOCK_NAME } = await bindingTransaction();
  const { directory } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
  ]);
  const lock = path.join(directory, LOCK_NAME);
  try {
    // The instance a delayed reclaimer read and judged abandoned.
    const judged = await acquireLockInstance(lock);
    assert.equal((await heldLockOwner(lock)).instance, judged);

    // That holder's own run ends and a different, live binder takes the lock.
    assert.equal(await retireLockInstance(lock, judged), true);
    assert.equal(fs.existsSync(lock), false, "a retired instance left the lock behind");
    const live = await acquireLockInstance(lock);
    assert.notEqual(live, judged);

    // Only now does the delayed reclaimer act on what it read.
    assert.equal(
      await retireLockInstance(lock, judged),
      false,
      "a reclaimer took an instance it had not judged",
    );
    assert.equal(
      (await heldLockOwner(lock)).instance,
      live,
      "a stale reclaimer vacated a live binder's lock",
    );

    assert.equal(await retireLockInstance(lock, live), true);
    assert.equal(fs.existsSync(lock), false);
    assert.deepEqual(bindingResidue(directory), [], "the lock left a proof or a retirement behind");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// The same rule seen from the outside: a binder that finds a lock whose owner is gone but whose
// instance is no longer the one it judged refuses rather than reclaiming.
test("a binder refuses a lock that changed hands while it was reclaiming", async () => {
  const { bindDocuments, acquireLockInstance, LOCK_NAME } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
  ]);
  const lock = path.join(directory, LOCK_NAME);
  try {
    // A live holder, this process, so the owner is alive and the binder refuses without touching
    // anything the holder owns.
    const live = await acquireLockInstance(lock);
    const outcome = await bindDocuments({ docsDirectory: directory, plans });
    assert.equal(outcome.status, "blocked");
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one before\n");
    assert.equal(fs.existsSync(lock), true, "a refused binder removed the live holder's lock");
    assert.equal(await require("node:fs/promises").readFile(lock, "utf8").then((value) => JSON.parse(value).instance), live);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the lock is released even when the rollback itself fails", async () => {
  const { bindDocuments, JOURNAL_NAME, LOCK_NAME, recoverDocumentBinding } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
    { name: "two.md", original: "two before\n", next: "two after\n" },
  ]);
  try {
    const outcome = await bindDocuments({
      docsDirectory: directory,
      plans,
      hooks: {
        beforeRename: (record) => {
          if (record.relative === "docs/two.md") throw new Error("rename refused");
        },
        beforeRollback: (record) => {
          if (record.relative === "docs/one.md") throw new Error("rollback refused");
        },
      },
    });
    assert.equal(outcome.status, "unrecovered");
    assert.deepEqual(outcome.rollbackFailures.length, 1);
    assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), false, "a failed rollback left a stale lock");
    assert.equal(
      fs.existsSync(path.join(directory, JOURNAL_NAME)),
      true,
      "a failed rollback left no journal for the next run to recover from",
    );
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one after\n");

    const recovery = await recoverDocumentBinding(directory);
    assert.deepEqual(recovery.failures, []);
    assert.deepEqual(recovery.recovered, ["docs/one.md"]);
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one before\n");
    assert.equal(fs.readFileSync(plans[1].file, "utf8"), "two before\n");
    assert.deepEqual(bindingResidue(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a binder killed between renames is recovered by the next run", async () => {
  const { bindDocuments, JOURNAL_NAME } = await bindingTransaction();
  const { directory, plans } = bindingFixture([
    { name: "one.md", original: "one before\n", next: "one after\n" },
    { name: "two.md", original: "two before\n", next: "two after\n" },
  ]);
  try {
    const probe = path.join(directory, "crash.mjs");
    fs.writeFileSync(probe, [
      `import { bindDocuments } from ${JSON.stringify(pathToFileURL(path.join(root, "scripts", "lib", "documentBindingTransaction.mjs")).href)};`,
      `const plans = ${JSON.stringify(plans)};`,
      `await bindDocuments({`,
      `  docsDirectory: ${JSON.stringify(directory)},`,
      `  plans,`,
      `  hooks: { afterRename: (record) => { if (record.relative === "docs/one.md") process.exit(7); } },`,
      `});`,
    ].join("\n"), "utf8");
    const crashed = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 30_000 });
    assert.equal(crashed.status, 7, crashed.stderr ?? "");
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one after\n");
    assert.equal(fs.readFileSync(plans[1].file, "utf8"), "two before\n");
    assert.equal(fs.existsSync(path.join(directory, JOURNAL_NAME)), true, "no journal survived the crash");

    const outcome = await bindDocuments({ docsDirectory: directory, plans });
    assert.deepEqual(outcome.recovered, ["docs/one.md", "docs/two.md"]);
    assert.equal(outcome.status, "bound");
    assert.equal(fs.readFileSync(plans[0].file, "utf8"), "one after\n");
    assert.equal(fs.readFileSync(plans[1].file, "utf8"), "two after\n");
    assert.deepEqual(bindingResidue(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// An unpackaged tree is the ordinary state of this repository, and the command must say so
// in one instruction rather than dying with an unhandled ENOENT from its artifact read.
// The gate runs against an isolated package fixture rather than this checkout, so the
// absent-artifact path is exercised whether or not a real candidate happens to be staged,
// and no real artifact is moved. The fixture carries a version no build ever produces.
const FIXTURE_VERSION = "0.0.0-release-verify-fixture";

const releaseVerifyFixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-release-verify-fixture-"));
  fs.cpSync(path.join(root, "scripts"), path.join(directory, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: "bachata-vscode-release-verify-fixture", version: FIXTURE_VERSION, private: true }, undefined, 2)}\n`,
    "utf8",
  );
  // A junction rather than a copy: 150 MB of dependencies would make this test unusable,
  // and "junction" is the one symlink type Windows creates without elevation.
  fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
  return directory;
};

test("release verification reports an absent candidate as an instruction, not a stack", () => {
  const fixture = releaseVerifyFixture();
  try {
    const candidate = path.join(fixture, `bachata-vscode-${FIXTURE_VERSION}.vsix`);
    assert.equal(fs.existsSync(candidate), false, "the fixture must start with no candidate");

    const child = spawnSync(process.execPath, [path.join(fixture, "scripts", "release-verify.mjs")], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;

    assert.equal(child.status, 1, `an absent candidate must fail the gate: ${output.slice(0, 400)}`);
    assert.match(
      output,
      new RegExp(`No staged bachata-vscode-${FIXTURE_VERSION.replace(/\./gu, "\\.")}\\.vsix was found`, "u"),
      `the diagnostic must name the candidate it looked for: ${output.slice(0, 400)}`,
    );
    assert.match(output, /npm run package/u, "the diagnostic must name the command that builds a candidate");
    assert.match(output, /npm run release:bind/u, "the diagnostic must name the binding step that follows");

    // The failure a reader sees must be the sentence above, not Node's rendering of an
    // unhandled rejection from deep inside the artifact reader.
    assert.equal(/ENOENT/u.test(output), false, `a raw errno leaked into the diagnostic: ${output.slice(0, 400)}`);
    assert.equal(/no such file or directory/u.test(output), false, `a raw syscall message leaked: ${output.slice(0, 400)}`);
    assert.equal(/^\s+at .+/mu.test(output), false, `a stack frame leaked into the diagnostic: ${output.slice(0, 400)}`);
    assert.equal(
      /openPinnedArtifact|readArtifactSnapshot|node:internal/u.test(output),
      false,
      `an internal frame leaked into the diagnostic: ${output.slice(0, 400)}`,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// EX-G6-16. On Windows `npm` is `npm.cmd`, a batch shim, and since the CVE-2024-27980 fix Node
// refuses to execute `.cmd` and `.bat` files unless a command interpreter is asked for. Packaging
// named the shim and passed no interpreter, and the lockfile gate passed `shell: false`
// outright — so both failed with EINVAL on every current Node on Windows. One shared helper is
// what keeps the executable and the interpreter from drifting apart again.
test("every npm invocation uses the one platform-correct helper", () => {
  const helper = fs.readFileSync(path.join(root, "scripts", "lib", "npmCommand.mjs"), "utf8");
  assert.match(helper, /process\.platform === "win32"/u);
  assert.match(helper, /npm\.cmd/u);
  assert.match(helper, /shell: true/u);

  const scripts = fs.readdirSync(path.join(root, "scripts"))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(root, "scripts", name), "utf8") }));
  const offenders = scripts.filter(({ name, source }) =>
    name !== "lib" && /["']npm\.cmd["']/u.test(source));
  assert.deepEqual(
    offenders.map((entry) => entry.name),
    [],
    "a script names the Windows npm shim itself instead of using the shared helper",
  );
  scripts
    .filter(({ source }) => /npmExecutable/u.test(source))
    .forEach(({ name, source }) => {
      assert.match(
        source,
        /from "\.\/lib\/npmCommand\.mjs"/u,
        `${name} uses npmExecutable without importing the shared helper`,
      );
    });
  assert.ok(
    scripts.some(({ name }) => name === "package.mjs") &&
      /npmSpawnOptions\(/u.test(
        fs.readFileSync(path.join(root, "scripts", "package.mjs"), "utf8"),
      ),
    "packaging does not start npm through the shared helper",
  );
});
