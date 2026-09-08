const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = { repository: "owner/extension", commit: "a".repeat(40), runId: "12", runAttempt: "2" };
const withBundle = async (body) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bachata-release-bundle-"));
  const verdict = "# Release verdict\n\n## Verdict\n\n**SHIP as a stable release.**\n";
  const manifest = { schemaVersion: 1, ...expected, verdictSha256: digest(verdict) };
  try {
    for (const [kind, file] of [["vscode", "bachata-vscode-0.7.0.vsix"], ["bridge", "bachata-browser-bridge-0.7.0.zip"]]) {
      manifest[kind] = { file, version: "0.7.0", sha256: digest(kind) };
      await writeFile(path.join(directory, file), kind);
    }
    await writeFile(path.join(directory, "RELEASE_VERDICT.md"), verdict);
    await writeFile(path.join(directory, "release-set.json"), JSON.stringify(manifest));
    await body(directory, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("deployment refuses changed bytes, unknown files, stale attempts and traversal", async () => {
  const { verifyReleaseBundle } = await import("../scripts/release-bundle.mjs");
  await withBundle(async (directory, manifest) => {
    const bundle = await verifyReleaseBundle(directory, expected);
    assert.equal(bundle.bridge.bytes.toString(), "bridge");
    await assert.rejects(verifyReleaseBundle(directory, { ...expected, runAttempt: "1" }), /provenance/u);
    await assert.rejects(verifyReleaseBundle(directory, { ...expected, commit: "b".repeat(40) }), /provenance/u);
    await writeFile(path.join(directory, "unexpected.vsix"), "other");
    await assert.rejects(verifyReleaseBundle(directory, expected), /unexpected/u);
    await rm(path.join(directory, "unexpected.vsix"));
    await writeFile(path.join(directory, manifest.bridge.file), "changed");
    await assert.rejects(verifyReleaseBundle(directory, expected), /digest mismatch/u);
    manifest.vscode.file = "../outside.vsix";
    await writeFile(path.join(directory, "release-set.json"), JSON.stringify(manifest));
    await assert.rejects(verifyReleaseBundle(directory, expected), /Invalid vscode/u);
  });
});

test("publication never treats NO-SHIP or an unrelated SHIP mention as approval", async () => {
  const { requireShipVerdict, verifyReleaseBundle } = await import("../scripts/release-bundle.mjs");
  for (const document of ["**SHIP**", "## Verdict\n\n**NO-SHIP**\n\n## Old\n\n**SHIP**", "## Verdict\n\nPending.\n**SHIP**"]) {
    assert.throws(() => requireShipVerdict(document), /human SHIP verdict/u);
  }
  await withBundle(async (directory) => {
    await writeFile(path.join(directory, "RELEASE_VERDICT.md"), "## Verdict\n\n**SHIP**\nchanged");
    await assert.rejects(verifyReleaseBundle(directory, expected), /verdict digest/u);
  });
});

const env = {
  CWS_CLIENT_ID: "fixture-client", CWS_CLIENT_SECRET: "fixture-secret", CWS_REFRESH_TOKEN: "fixture-refresh",
  CWS_PUBLISHER_ID: "publisher-id", CWS_EXTENSION_ID: "a".repeat(32),
};
const identity = { name: `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`, itemId: env.CWS_EXTENSION_ID };
const responses = (values, calls) => async (url, options) => {
  calls.push({ url, ...options });
  assert.ok(values.length, "unexpected request");
  const value = values.shift();
  return { ok: true, json: async () => value };
};

test("Chrome publishes only after async upload success and keeps review enabled", async () => {
  const { publishChromeStore } = await import("../scripts/publish-chrome-store.mjs");
  const calls = [];
  const bytes = Buffer.from("exact fixture ZIP");
  const state = await publishChromeStore({
    bytes, version: "0.7.0", env, wait: async () => {},
    request: responses([
      { access_token: "fixture-access" }, { ...identity, uploadState: "IN_PROGRESS" },
      { ...identity, lastAsyncUploadState: "IN_PROGRESS" },
      { ...identity, lastAsyncUploadState: "SUCCEEDED" }, { ...identity, state: "PENDING_REVIEW" },
    ], calls),
  });
  assert.equal(state, "PENDING_REVIEW");
  assert.equal(calls[1].body, bytes);
  assert.equal(calls.length, 5);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { publishType: "DEFAULT_PUBLISH", skipReview: false, blockOnWarnings: true });
  assert.ok(calls.every((call) => call.redirect === "error" && call.signal));
});

test("Chrome refuses failed uploads, foreign items, wrong versions and rejected submissions", async () => {
  const { publishChromeStore } = await import("../scripts/publish-chrome-store.mjs");
  for (const upload of [
    { ...identity, uploadState: "FAILED" },
    { ...identity, itemId: "b".repeat(32), uploadState: "SUCCEEDED", crxVersion: "0.7.0" },
    { ...identity, uploadState: "SUCCEEDED", crxVersion: "0.6.0" },
  ]) {
    const calls = [];
    await assert.rejects(publishChromeStore({
      bytes: Buffer.from("zip"), version: "0.7.0", env,
      request: responses([{ access_token: "fixture-access" }, upload], calls),
    }));
    assert.equal(calls.length, 2);
  }
  await assert.rejects(publishChromeStore({
    bytes: Buffer.from("zip"), version: "0.7.0", env,
    request: responses([{ access_token: "fixture-access" },
      { ...identity, uploadState: "SUCCEEDED", crxVersion: "0.7.0" },
      { ...identity, state: "REJECTED" }], []),
  }), /did not accept/u);
});

test("Chrome upload polling is bounded and never submits a timed-out upload", async () => {
  const { publishChromeStore } = await import("../scripts/publish-chrome-store.mjs");
  const calls = [];
  await assert.rejects(publishChromeStore({
    bytes: Buffer.from("zip"), version: "0.7.0", env, wait: async () => {},
    request: responses([{ access_token: "fixture-access" }, { ...identity, uploadState: "IN_PROGRESS" },
      ...Array.from({ length: 30 }, () => ({ ...identity, lastAsyncUploadState: "IN_PROGRESS" }))], calls),
  }), /did not succeed/u);
  assert.equal(calls.length, 32);
  assert.equal(calls.some((call) => call.url.endsWith(":publish")), false);
});

test("Chrome errors do not echo credentials or provider error bodies", async () => {
  const { publishChromeStore } = await import("../scripts/publish-chrome-store.mjs");
  await assert.rejects(publishChromeStore({
    bytes: Buffer.from("zip"), version: "0.7.0", env,
    request: async () => ({ ok: false, status: 403, json: async () => ({ error: env.CWS_CLIENT_SECRET }) }),
  }), (error) => /HTTP 403/u.test(error.message) && !error.message.includes(env.CWS_CLIENT_SECRET));
});

test("deployment provenance rejects a different commit, attempt or event", async () => {
  const { bridgeRunFindings } = await import("../scripts/verify-bridge-run.mjs");
  const valid = { status: "completed", conclusion: "success", path: ".github/workflows/paired-release.yml@main",
    head_repository: { full_name: expected.repository }, head_sha: expected.commit, run_attempt: 2, event: "workflow_dispatch" };
  const wanted = { repository: expected.repository, workflowPath: ".github/workflows/paired-release.yml",
    commit: expected.commit, attempt: "2", event: "workflow_dispatch" };
  assert.deepEqual(bridgeRunFindings(valid, wanted), []);
  for (const changed of [{ head_sha: "b".repeat(40) }, { run_attempt: 1 }, { event: "pull_request" }, { conclusion: "failure" }]) {
    assert.ok(bridgeRunFindings({ ...valid, ...changed }, wanted).length > 0);
  }
});
