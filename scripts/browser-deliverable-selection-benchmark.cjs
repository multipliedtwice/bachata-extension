"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { buildSelectionRequest, selectionSchema, resolveSelection, implementationHashes } = require("./lib/browserDeliverableSelection.cjs");
const { readDeliverableZip } = require("../dist/browser/deliverableArchive.js");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const MODELS = ["qwen3.5:4b-q4_K_M", "ministral-3:8b-instruct-2512-q4_K_M", "digitsflow/bonsai-8b:latest"];
async function main() {
  const [fixtureRoot, output, transport] = process.argv.slice(2);
  if (transport !== undefined && transport !== "--schema") throw new Error("Unknown transport option");
  if (!fixtureRoot || !output || !path.isAbsolute(fixtureRoot) || !path.isAbsolute(output)) throw new Error("Usage: node script ABSOLUTE_CAPTURE_ROOT ABSOLUTE_REPORT_JSON");
  const found = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name)) await walk(file);
      else if (entry.name === "capture.json") {
        const match = file.match(/format-(markdown|diff|listing|zip-link)[/\\]/u);
        if (match && !found[match[1]]) found[match[1]] = file;
      }
    }
  }
  await walk(fixtureRoot);
  const fixtures = [];
  for (const format of ["markdown", "listing", "diff", "zip-link"]) {
    if (!found[format]) throw new Error(`Missing ${format} capture`);
    const data = await fs.readFile(found[format]), capture = JSON.parse(data);
    let bytes, requiredPaths = format === "listing" ? ["a.txt", "nested/b.txt"] : ["note.md"];
    if (format === "zip-link") {
      bytes = await fs.readFile(path.join(path.dirname(found[format]), capture.assets[0].name));
      requiredPaths = (await readDeliverableZip(bytes, new AbortController().signal)).map(({ path: file }) => file);
    }
    fixtures.push({ name: format, capture, requirement: { format: format === "zip-link" ? "zip" : format, paths: requiredPaths }, bytes,
      capturePath: found[format], captureSha256: hash(data) });
  }
  const missing = structuredClone(fixtures[1]); missing.name = "listing-missing-required-path"; missing.requirement.paths.push("missing.txt"); fixtures.push(missing);
  const report = { schemaVersion: 1, kind: "local-model-deliverable-contract-replay", startedAt: new Date().toISOString(),
    browserPromptsSent: 0, cases: [], models: MODELS, structuredOutput: transport === "--schema",
    contractSha256: hash(await fs.readFile(path.join(__dirname, "lib/browserDeliverableSelection.cjs"))),
    implementationSha256: await implementationHashes(),
    limitations: "Recorded real Bridge captures; current local models. ZIP transport is reconstructed from saved bytes. No application mutations or new live browser responses." };
  const save = () => fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  await save();
  for (const model of MODELS) for (const fixture of fixtures) {
    const request = buildSelectionRequest(fixture.capture, fixture.requirement);
    const record = { model, fixture: fixture.name, capturePath: fixture.capturePath, captureSha256: fixture.captureSha256,
      startedAt: new Date().toISOString(), candidateIds: request.candidates.map(({ id }) => id) };
    report.cases.push(record); await save();
    try {
      const response = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: JSON.stringify(request) }], format: transport === "--schema" ? selectionSchema(request) : "json", stream: false, think: false,
          keep_alive: "2m", options: { temperature: 0, num_ctx: 4096, num_predict: 256 } }), signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Local interpreter HTTP ${response.status}`);
      const body = await response.json(); record.raw = body.message?.content; record.decision = JSON.parse(record.raw);
      const expectedRefusal = fixture.name === "listing-missing-required-path";
      const fetchAsset = async function* (assetId) {
        const bytes = fixture.bytes, asset = fixture.capture.assets.find((asset) => asset.id === assetId);
        yield { type: "start", assetId, name: asset.name, size: bytes.length };
        yield { type: "chunk", assetId, sequence: 0, data: bytes };
        yield { type: "complete", assetId, size: bytes.length, sha256: hash(bytes) };
      };
      try {
        const selected = await resolveSelection(fixture.capture, fixture.requirement, record.decision,
          { signal: new AbortController().signal, fetchAsset });
        record.kind = selected.kind; record.provenance = selected.provenance; record.completeness = selected.completeness;
        record.passed = expectedRefusal ? selected.kind === "abstain" : selected.kind === "selected";
      } catch (error) {
        record.refusal = error.message;
        record.passed = expectedRefusal && (/omits required paths/u.test(error.message)
          || (fixture.name === "diff" && Number.isInteger(error.status)));
      }
      record.expected = expectedRefusal ? "refusal-or-abstention" : "exact-selection";
    } catch (error) { record.error = error.message; record.passed = false; }
    record.completedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ model, fixture: fixture.name, passed: record.passed, kind: record.kind, refusal: record.refusal, error: record.error }));
  }
  report.passed = report.cases.every(({ passed }) => passed); report.completedAt = new Date().toISOString(); await save();
  if (!report.passed) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
