const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { crc32 } = require("node:zlib");
const { PROTOCOL, buildSelectionRequest, unambiguousSelection, resolveSelection } = require("../scripts/lib/browserDeliverableSelection.cjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const capture = (parts, assets = []) => {
  let offset = 0;
  const segments = parts.map((part) => { const start = offset; offset += part.text.length; return { ...part, start, end: offset }; });
  return { requestId: "request-1", provider: "generic", sessionId: "session-1", finalSessionId: "session-2",
    finalConversationIdentity: "generic:conversation-2", fidelity: "bestEffort", captureFormat: "renderedText",
    text: segments.map(({ text }) => text).join(""), segments, assets };
};
const decision = (request, ids = request.candidates.map(({ id }) => id)) => ({ protocol: PROTOCOL,
  captureId: request.captureId, selectedIds: ids });
const text = (value) => ({ type: "text", text: value });
const block = (language, value) => ({ type: "codeBlock", language, text: value });
const zip = (entries) => {
  let offset = 0;
  const local = [], central = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.path), data = Buffer.from(entry.text);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
};
const asset = (data) => ({ id: "download-1", provider: "generic", kind: "generatedFile", name: "sources.zip", size: data.length,
  downloadAvailable: true, sourceElement: "assistantMessage", previewText: "FILE a.md\nFILE b.md" });
const transfer = (data, incomplete = false) => async function* (id) {
  yield { type: "start", assetId: id, name: "sources.zip", size: data.length };
  yield { type: "chunk", assetId: id, sequence: 0, data };
  if (!incomplete) yield { type: "complete", assetId: id, size: data.length, sha256: hash(data) };
};

test("Markdown selection copies exact multilingual bytes with capture and segment provenance", async () => {
  const source = "# Notes\n\nThai: \u0e0d. Russian: \u043f\u0440\u0438\u0432\u0435\u0442.\n";
  const c = capture([text("FILE note.md\n"), block("markdown", source)]), requirement = { format: "markdown", paths: ["note.md"] };
  const request = buildSelectionRequest(c, requirement), result = await resolveSelection(c, requirement, decision(request));
  assert.equal(result.files[0].data.toString("utf8"), source);
  assert.equal(result.provenance.evidence[0].sha256, hash(Buffer.from(source)));
  assert.equal(result.provenance.requestId, c.requestId); assert.equal(result.provenance.finalSessionId, c.finalSessionId);
  assert.deepEqual(result.completeness, { requestedPaths: "complete", captureCoverage: "exact", providerFidelity: "bestEffort", taskCorrectness: "unverified" });
});

test("multi-file selection cannot label an omitted, duplicate or stale source complete", async () => {
  const c = capture([text("FILE a.md\n"), block("markdown", "a\n"), text("\nFILE b.md\n"), block("md", "b\n")]);
  const requirement = { format: "markdown", paths: ["a.md", "b.md"] }, request = buildSelectionRequest(c, requirement);
  await assert.rejects(resolveSelection(c, requirement, decision(request, ["segment:1"])), /omits/);
  await assert.rejects(resolveSelection(c, requirement, decision(request, ["segment:1", "segment:1"])), /invalid/);
  const changed = structuredClone(c); changed.requestId = "request-2";
  await assert.rejects(resolveSelection(changed, requirement, decision(request)), /stale/);
  const rewritten = { ...decision(request), content: "invented" };
  await assert.rejects(resolveSelection(c, requirement, rewritten), /invalid/);
  await assert.rejects(resolveSelection(c, requirement, { ...decision(request), completeness: "complete" }), /invalid/);
  assert.equal((await resolveSelection(c, requirement, decision(request, []))).kind, "abstain");
  assert.equal((await resolveSelection(c, requirement, decision(request))).files.length, 2);
});

test("plain listings require the exact manifest, and quoted or decorated lists supply no authority", async () => {
  const requirement = { format: "listing", paths: ["a.txt", "nested/b.txt"] };
  const c = capture([text("FILE a.txt\nFILE nested/b.txt\n")]), request = buildSelectionRequest(c, requirement);
  const result = await resolveSelection(c, requirement, decision(request));
  assert.equal(result.bytes.toString(), c.text);
  for (const part of [{ type: "quote", text: c.text }, text("Example:\n" + c.text), text("FILE a.txt\nFILE a.txt"), text("FILE ../a.txt")]) {
    assert.equal(buildSelectionRequest(capture([part]), requirement).candidates.length, 0);
  }
  const partial = capture([text("FILE a.txt")]), partialRequest = buildSelectionRequest(partial, requirement);
  await assert.rejects(resolveSelection(partial, requirement, decision(partialRequest)), /omits/);
});

test("diff references preserve exact bytes and reject malformed hunks and changed targets", async () => {
  const patch = "--- a/note.md\n+++ b/note.md\n@@ -1 +1,2 @@\n alpha\n+beta\n";
  const requirement = { format: "diff", paths: ["note.md"] }, c = capture([text("PATCH note.md\n"), block("diff", patch)]);
  assert.equal((await resolveSelection(c, requirement, decision(buildSelectionRequest(c, requirement)))).bytes.toString(), patch);
  const broken = capture([text("PATCH note.md\n"), block("diff", patch.replace("+1,2", "+1,9"))]);
  await assert.rejects(resolveSelection(broken, requirement, decision(buildSelectionRequest(broken, requirement))));
  assert.equal(buildSelectionRequest(capture([text("Example: PATCH note.md\n"), block("diff", patch)]), requirement).candidates.length, 0);
  const rendered = capture([block("diff", patch.trimEnd())]), request = buildSelectionRequest(rendered, requirement);
  const normalized = await resolveSelection(rendered, requirement, decision(request));
  assert.equal(normalized.bytes.toString(), patch);
  assert.equal(normalized.provenance.evidence[0].sha256, hash(Buffer.from(patch.trimEnd())));
  assert.equal(normalized.provenance.evidence[0].preparedSha256, hash(Buffer.from(patch)));
  assert.deepEqual(normalized.provenance.evidence[0].transformations, ["appendUnifiedDiffRecordTerminator"]);
});

test("ZIP manifest completeness comes from verified archive bytes, never preview text", async () => {
  const requirement = { format: "zip", paths: ["a.md", "b.md"] }, signal = new AbortController().signal;
  const data = zip([{ path: "a.md", text: "a\n" }, { path: "b.md", text: "b\u0e0d\n" }]);
  const c = capture([text("Sources attached")], [asset(data)]), request = buildSelectionRequest(c, requirement);
  const result = await resolveSelection(c, requirement, decision(request), { signal, fetchAsset: transfer(data) });
  assert.equal(result.files[1].data.toString(), "b\u0e0d\n"); assert.equal(result.provenance.evidence[0].sha256, hash(data));
  await assert.rejects(resolveSelection(c, requirement, decision(request)), /verified download/);
  await assert.rejects(resolveSelection(c, requirement, decision(request), { signal, fetchAsset: transfer(data, true) }), /completion/);
  for (const entries of [[{ path: "a.md", text: "only a" }], [{ path: "a.md", text: "a" }, { path: "b.md", text: "b" }, { path: "junk.md", text: "extra" }]]) {
    const incomplete = zip(entries), captured = capture([text("Complete sources")], [asset(incomplete)]);
    await assert.rejects(resolveSelection(captured, requirement, decision(buildSelectionRequest(captured, requirement)), { signal, fetchAsset: transfer(incomplete) }), /omits|required paths/);
  }
});

test("capture gaps, duplicate assets and invented IDs fail closed", async () => {
  const requirement = { format: "listing", paths: ["a.txt"] }, c = capture([text("FILE a.txt")]);
  const request = buildSelectionRequest(c, requirement);
  await assert.rejects(resolveSelection(c, requirement, decision(request, ["segment:99"])), /invented/);
  c.segments[0].end--; assert.throws(() => buildSelectionRequest(c, requirement), /coverage/);
  const data = zip([{ path: "a.txt", text: "a" }]);
  assert.throws(() => buildSelectionRequest(capture([], [asset(data), asset(data)]), { format: "zip", paths: ["a.txt"] }), /duplicated/);
});

test("unambiguous explicit formats route locally while duplicate representations abstain", async () => {
  const requirement = { format: "markdown", paths: ["note.md"] };
  const c = capture([text("FILE note.md\n"), block("md", "note\n")]);
  const request = buildSelectionRequest(c, requirement);
  assert.deepEqual(unambiguousSelection(request), decision(request));
  assert.equal((await resolveSelection(c, requirement, unambiguousSelection(request))).kind, "selected");
  const duplicated = capture([...c.segments, text("\nFILE note.md\n"), block("md", "other")]);
  const ambiguous = buildSelectionRequest(duplicated, requirement);
  assert.deepEqual(unambiguousSelection(ambiguous).selectedIds, []);
});

test("selection keeps validated provenance and requirements while awaiting an external download", async () => {
  const data = zip([{ path: "a.md", text: "source\n" }]);
  const captured = capture([text("Attached source")], [asset(data)]), requirement = { format: "zip", paths: ["a.md"] };
  const request = buildSelectionRequest(captured, requirement), choice = decision(request);
  const fetchAsset = async function* (id) {
    yield { type: "start", assetId: id, name: "sources.zip", size: data.length };
    captured.requestId = "changed-request"; captured.assets[0].name = "other.zip";
    requirement.format = "diff"; requirement.paths.push("extra.md"); choice.selectedIds.push("invented");
    yield { type: "chunk", assetId: id, sequence: 0, data };
    yield { type: "complete", assetId: id, size: data.length, sha256: hash(data) };
  };
  const result = await resolveSelection(captured, requirement, choice, { signal: new AbortController().signal, fetchAsset });
  assert.equal(result.kind, "selected"); assert.equal(result.format, "zip");
  assert.equal(result.provenance.requestId, "request-1"); assert.equal(result.provenance.evidence[0].name, "sources.zip");
  assert.deepEqual(result.paths, ["a.md"]);
});
