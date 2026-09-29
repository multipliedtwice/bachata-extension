"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { buildSelectionRequest, unambiguousSelection, resolveSelection, implementationHashes } = require("./lib/browserDeliverableSelection.cjs");
const { readDeliverableZip } = require("../dist/browser/deliverableArchive.js");
const hash = (data) => createHash("sha256").update(data).digest("hex");
async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output) || input === output) throw new Error("Pass distinct absolute input and output report paths");
  const original = JSON.parse(await fs.readFile(input, "utf8"));
  if (original.kind !== "local-model-deliverable-contract-replay" || !original.completedAt) throw new Error("Input must be a completed model replay report");
  const report = { schemaVersion: 1, kind: "controller-revalidation-of-recorded-model-decisions", recordedAt: new Date().toISOString(),
    sourceReport: input, sourceReportSha256: hash(await fs.readFile(input)),
    currentContractSha256: hash(await fs.readFile(path.join(__dirname, "lib/browserDeliverableSelection.cjs"))),
    implementationSha256: await implementationHashes(),
    modelRequestsSent: 0, browserPromptsSent: 0, cases: [] };
  for (const recorded of original.cases) {
    const data = await fs.readFile(recorded.capturePath);
    if (hash(data) !== recorded.captureSha256) throw new Error("Recorded capture changed");
    const capture = JSON.parse(data), format = recorded.fixture === "zip-link" ? "zip" : recorded.fixture.startsWith("listing") ? "listing" : recorded.fixture;
    let bytes, paths = format === "listing" ? ["a.txt", "nested/b.txt"] : ["note.md"];
    if (format === "zip") {
      bytes = await fs.readFile(path.join(path.dirname(recorded.capturePath), capture.assets[0].name));
      paths = (await readDeliverableZip(bytes, new AbortController().signal)).map((entry) => entry.path);
    }
    if (recorded.fixture === "listing-missing-required-path") paths.push("missing.txt");
    const requirement = { format, paths }, request = buildSelectionRequest(capture, requirement);
    const options = { signal: new AbortController().signal, fetchAsset: async function* (assetId) {
      const asset = capture.assets.find((item) => item.id === assetId);
      yield { type: "start", assetId, name: asset.name, size: bytes.length };
      yield { type: "chunk", assetId, sequence: 0, data: bytes };
      yield { type: "complete", assetId, size: bytes.length, sha256: hash(bytes) };
    } };
    const record = { interpreter: recorded.model, fixture: recorded.fixture, capturePath: recorded.capturePath, captureSha256: recorded.captureSha256 };
    for (const [route, decision] of [["model", recorded.decision], ["deterministic", unambiguousSelection(request)]]) {
      try {
        const result = await resolveSelection(capture, requirement, decision, options);
        record[route] = { kind: result.kind, provenance: result.provenance, completeness: result.completeness,
          passed: recorded.fixture === "listing-missing-required-path" ? result.kind === "abstain" : result.kind === "selected" };
      } catch (error) { record[route] = { refusal: error.message,
        passed: recorded.fixture === "listing-missing-required-path" && /omits required paths/u.test(error.message) }; }
    }
    report.cases.push(record);
  }
  report.deterministicPasses = report.cases.filter(({ deterministic }) => deterministic.passed).length;
  report.modelPasses = report.cases.filter(({ model }) => model.passed).length;
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ cases: report.cases.length, deterministicPasses: report.deterministicPasses, modelPasses: report.modelPasses,
    perModel: original.models.map((name) => ({ name, passed: report.cases.filter((entry) => entry.interpreter === name && entry.model.passed).length })) }));
  if (report.deterministicPasses !== report.cases.length) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
