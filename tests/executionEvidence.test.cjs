const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createExecutionEvidenceStore, evidenceDigest, EXECUTION_EVIDENCE_LIMITS, parseEvidenceManifest } = require("../dist/state/executionEvidence.js");
const { exportExecutionEvidence } = require("../dist/export/executionEvidence.js");

const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-exact-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: createExecutionEvidenceStore(root, { runId: "run", taskId: "task" }) };
};

test("admitted UTF-8 pages reconstruct exact post-redaction bytes and disclose privacy changes", async (t) => {
  const { store } = await fixture(t);
  const input = "ไทย🙂\npassword=private-value\nend";
  const record = await store.put({ kind: "answer", source: "dispatch", content: input, candidate: "c1" });
  const { content } = await store.read(record.id, "worker");
  assert.equal(content, "ไทย🙂\npassword=[REDACTED]\nend");
  assert.equal(record.digest, evidenceDigest(content));
  assert.equal(record.byteLength, Buffer.byteLength(content));
  assert.equal(record.completeness, "complete");
  assert.ok(record.redactions.length);
  const cut = Buffer.byteLength("ไทย🙂\n");
  const first = await store.page({ id: record.id, reader: "worker", start: 0, end: cut, candidate: "c1", use: "current" });
  const last = await store.page({ id: record.id, reader: "worker", start: cut, end: record.byteLength, candidate: "c1", use: "current" });
  assert.equal(first.text + last.text, content);
  assert.equal(first.nextStart, cut);
  assert.equal(last.nextStart, null);
  await assert.rejects(store.page({ id: record.id, reader: "worker", start: 1, end: cut, candidate: "c1", use: "current" }));
  await assert.rejects(store.page({ id: record.id, reader: "worker", start: 0, end: cut, candidate: "c2", use: "current" }), /Historical/);
  assert.equal((await store.page({ id: record.id, reader: "worker", start: 0, end: cut, candidate: "c2", use: "history" })).historical, true);
});

test("corruption, missing blobs, wrong scope, unauthorized readers and admission overflow fail closed", async (t) => {
  const { root, store } = await fixture(t);
  const record = await store.put({ kind: "controller", source: "check", content: "exact" });
  const other = createExecutionEvidenceStore(root, { runId: "other", taskId: "task" });
  await assert.rejects(other.read(record.id, "worker"), /unavailable/);
  const locator = await store.put({ kind: "providerLocator", source: "claude", content: "private-session" });
  await assert.rejects(store.read(locator.id, "export"), /unauthorized/);
  await fs.writeFile(path.join(store.directory, record.storage), "wrong");
  await assert.rejects(store.read(record.id, "controller"), /integrity/);
  await fs.unlink(path.join(store.directory, record.storage));
  await assert.rejects(store.read(record.id, "controller"), /ENOENT/);
  assert.throws(() => parseEvidenceManifest({ version: 2 }, { runId: "run", taskId: "task" }));
  const limited = createExecutionEvidenceStore(root, { runId: "limited", taskId: "task" });
  await assert.rejects(limited.put({ kind: "prompt", source: "oversize", content: "x".repeat(EXECUTION_EVIDENCE_LIMITS.recordBytes + 1) }), /too large/);
  assert.equal((await limited.manifest()).records.length, 0);
});

test("export survives preview pruning and excludes provider locators with per-record disclosure", async (t) => {
  const { root, store } = await fixture(t);
  await store.put({ kind: "providerLocator", source: "codex", content: "private-thread-123" });
  const answer = await store.put({ kind: "answer", source: "dispatch", content: '  {"sessionId":"private-thread-123","note":"https://example.com/private?q=1","text":"keep"}  ' });
  const plain = await store.put({ kind: "prompt", source: "dispatch", content: "exact\nไทย🙂\n" });
  await fs.writeFile(path.join(root, "transcript.jsonl"), "preview");
  await fs.unlink(path.join(root, "transcript.jsonl"));
  const exported = await exportExecutionEvidence(root);
  assert.ok(!exported.includes("private-thread-123"));
  assert.ok(!exported.includes("private?q=1"));
  assert.ok(!exported.includes(store.directory));
  const records = JSON.parse(exported).runs[0].records;
  assert.equal(records.find((record) => record.id === plain.id).content, "exact\nไทย🙂\n");
  const redacted = records.find((record) => record.id === answer.id);
  assert.equal(redacted.exactAdmittedContent, false);
  assert.equal(redacted.exportedDigest, evidenceDigest(redacted.content));
  assert.ok(redacted.redactions.length);
});

test("manifest publication follows blob durability and immutable records reject tampered metadata", async (t) => {
  const { root } = await fixture(t);
  const observed = [];
  const store = createExecutionEvidenceStore(root, { runId: "ordered", taskId: "task" }, {
    onRecord: async (record) => observed.push((await store.read(record.id, "controller")).content),
  });
  await Promise.all(["first", "second"].map((content) => store.put({ kind: "prompt", source: content, content })));
  assert.deepEqual(observed, ["first", "second"]);
  const manifest = await store.manifest();
  assert.throws(() => parseEvidenceManifest({ ...manifest, extra: true }, manifest));
  assert.throws(() => parseEvidenceManifest({ ...manifest, records: [manifest.records[0], manifest.records[0]] }, manifest));
  assert.throws(() => parseEvidenceManifest({ ...manifest, records: [{ ...manifest.records[0], storage: "../../outside" }] }, manifest));
});
