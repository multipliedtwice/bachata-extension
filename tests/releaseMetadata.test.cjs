const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const load = () => import(`file://${path.join(root, "scripts", "lib", "releaseMetadata.mjs")}`);

const VSIX_HASH = "a".repeat(64);
const BRIDGE_HASH = "b".repeat(64);

const artifacts = () => ({
  vsix: { version: "0.6.12", sha256: VSIX_HASH },
  bridge: { version: "0.6.7", sha256: BRIDGE_HASH },
});

const binding = `Artifacts under test: Bachata VSIX \`${VSIX_HASH}\`, Browser Bridge ZIP \`${BRIDGE_HASH}\`.`;

const validationRecord = () => `# Release validation record

${binding}

| Artifact | Version | SHA-256 | Recorded |
| --- | --- | --- | --- |
| Bachata VSIX | 0.6.12 | \`${VSIX_HASH}\` | yes |
| Browser Bridge ZIP | 0.6.7 | \`${BRIDGE_HASH}\` | yes |

| OS | VS Code version | VSIX SHA-256 | Date | Operator | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | 1.101.2 | \`${VSIX_HASH}\` | 2026-08-24 | operator | Pass | none |
`;

const providerTerms = () => `# Provider terms review

${binding}

| Provider | Terms reviewed | Reviewer | Date | VSIX SHA-256 | Outcome |
| --- | --- | --- | --- | --- | --- |
| Codex | Reviewed | operator | 2026-08-24 | \`${VSIX_HASH}\` | Permitted |
`;

const compatibilityMatrix = () => `# Compatibility matrix

${binding}

| Extension | VS Code version | Provider | Provider version | OS | Checklist | Date | VSIX SHA-256 | Result | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.6.12 | 1.101.2 | Codex app server | 1.0.0 | macOS | HUMAN_E2E | 2026-08-24 | \`${VSIX_HASH}\` | Pass | none |
`;

const completeInput = () => ({
  packageJson: {
    version: "0.6.12",
    publisher: "example-publisher",
    displayName: "Bachata",
    description: "Human-directed LLM refinement across fresh review cycles with compressed core decisions.",
    license: "MIT",
    repository: { type: "git", url: "https://example.com/bachata-vscode.git" },
    homepage: "https://example.com/bachata-vscode",
    bugs: { url: "https://example.com/bachata-vscode/issues" },
    qna: "https://example.com/bachata-vscode/discussions",
    sponsor: { url: "https://example.com/bachata-vscode/support" },
  },
  readme: "![Setup](media/screenshots/setup-wizard.png)",
  screenshotFiles: ["media/screenshots/setup-wizard.png"],
  bridgeInstallDocument: "Official download: https://example.com/bridge/releases",
  validationRecord: validationRecord(),
  providerTerms: providerTerms(),
  compatibilityMatrix: compatibilityMatrix(),
  artifacts: artifacts(),
  schemas: fixtureSchemas(),
});

const fixtureSchemas = () => ({
  "docs/RELEASE_VALIDATION_RECORD.md": [{
    headers: ["OS", "VS Code version", "VSIX SHA-256", "Date", "Operator", "Result", "Notes"],
    rows: [{ OS: "macOS", "VS Code version": "1.101.2" }],
    requires: ["vsix"],
  }],
  "docs/PROVIDER_TERMS.md": [{
    headers: ["Provider", "Terms reviewed", "Reviewer", "Date", "VSIX SHA-256", "Outcome"],
    rows: [{ Provider: "Codex" }],
    requires: ["vsix"],
  }],
  "docs/COMPATIBILITY_MATRIX.md": [{
    headers: ["Extension", "VS Code version", "Provider", "Provider version", "OS", "Checklist", "Date", "VSIX SHA-256", "Result", "Known limitations"],
    rows: [{ Extension: "0.6.12", Provider: "Codex app server", OS: "macOS", Checklist: "HUMAN_E2E" }],
    requires: ["vsix"],
  }],
});

test("complete structured release evidence bound to the staged artifacts produces no findings", async () => {
  const { releaseMetadataFindings } = await load();
  assert.deepEqual(releaseMetadataFindings(completeInput()), []);
});

test("placeholder identity, missing evidence, and unrecorded rows all block release", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.packageJson.publisher = "local";
  input.packageJson.homepage = "https://todo-release.invalid/bachata-vscode";
  input.packageJson.displayName = "Pair";
  input.packageJson.repository = undefined;
  input.readme = "no screenshots here";
  input.screenshotFiles = [];
  input.bridgeInstallDocument = "download it from somewhere";
  input.validationRecord = input.validationRecord.replace(
    "| macOS | 1.101.2 | `" + VSIX_HASH + "` | 2026-08-24 | operator | Pass | none |",
    "| macOS | — | — | — | — | Not performed | — |",
  );
  input.providerTerms = input.providerTerms.replace(
    `| Codex | Reviewed | operator | 2026-08-24 | \`${VSIX_HASH}\` | Permitted |`,
    "| Codex | Not reviewed | — | — | — | — |",
  );
  input.compatibilityMatrix = input.compatibilityMatrix.replace(
    `| 0.6.12 | 1.101.2 | Codex app server | 1.0.0 | macOS | HUMAN_E2E | 2026-08-24 | \`${VSIX_HASH}\` | Pass | none |`,
    "| 0.6.12 | — | Codex app server | — | macOS | HUMAN_E2E | — | — | Not tested | — |",
  );
  const findings = releaseMetadataFindings(input);
  for (const marker of [
    "publisher is a placeholder",
    "displayName must be the canonical product name",
    "repository.url is a placeholder or missing",
    "homepage is a placeholder or missing",
    "references no screenshot",
    "no verified screenshot",
    "no real public Browser Bridge acquisition URL",
    'docs/RELEASE_VALIDATION_RECORD.md "macOS" is still unrecorded',
    'docs/PROVIDER_TERMS.md "Codex" is still unrecorded',
    'docs/COMPATIBILITY_MATRIX.md "0.6.12" is still unrecorded',
  ]) {
    assert.ok(findings.some((finding) => finding.includes(marker)), `Missing finding: ${marker}`);
  }
});

test("a plain http URL is refused", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.packageJson.bugs = { url: "http://example.com/issues" };
  assert.ok(releaseMetadataFindings(input).some((finding) => finding.includes("bugs.url must be an https URL")));
});

test("an arbitrary one-line record is no longer accepted as evidence", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.validationRecord = "| macOS | 1.101 | abc | 2026-01-01 | operator | Pass | - |";
  const findings = releaseMetadataFindings(input);
  assert.ok(findings.some((finding) => finding.includes("declares no record table")));
});

test("evidence produced from a different artifact is rejected", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  const stale = "c".repeat(64);
  input.validationRecord = input.validationRecord.replaceAll(VSIX_HASH, stale);
  const findings = releaseMetadataFindings(input);
  assert.ok(findings.some((finding) => finding.includes("does not bind its records to the staged Bachata VSIX")));
  assert.ok(findings.some((finding) => finding.includes("but the staged artifact is")));
  assert.ok(findings.some((finding) => finding.includes("is not a staged release artifact hash")));
});

test("a record with no artifact binding line is rejected", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.compatibilityMatrix = input.compatibilityMatrix.replace(binding, "");
  assert.ok(releaseMetadataFindings(input).some((finding) =>
    finding.includes('docs/COMPATIBILITY_MATRIX.md states no "Artifacts under test:" binding line')));
});

test("a non-ISO date and a non-terminal verdict are both rejected", async () => {
  const { releaseMetadataFindings } = await load();
  const dates = completeInput();
  dates.compatibilityMatrix = dates.compatibilityMatrix.replace("2026-08-24", "24 Aug 2026");
  assert.ok(releaseMetadataFindings(dates).some((finding) =>
    finding.includes("is not an ISO YYYY-MM-DD date")));

  const verdict = completeInput();
  verdict.compatibilityMatrix = verdict.compatibilityMatrix.replace("| Pass |", "| Mostly fine |");
  assert.ok(releaseMetadataFindings(verdict).some((finding) =>
    finding.includes("is not a terminal verdict")));
});

test("a row that omits a required cell is rejected", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.compatibilityMatrix = input.compatibilityMatrix.replace("| 1.0.0 |", "| — |");
  assert.ok(releaseMetadataFindings(input).some((finding) =>
    finding.includes("required cell(s) empty")));
});

test("the artifact table must name the staged version and hash", async () => {
  const { releaseMetadataFindings } = await load();
  const version = completeInput();
  version.validationRecord = version.validationRecord.replace("| Bachata VSIX | 0.6.12 |", "| Bachata VSIX | 0.6.11 |");
  assert.ok(releaseMetadataFindings(version).some((finding) =>
    finding.includes('records Bachata VSIX version "0.6.11"')));

  const mismatch = completeInput();
  mismatch.packageJson.version = "0.6.11";
  assert.ok(releaseMetadataFindings(mismatch).some((finding) =>
    finding.includes("does not match the staged VSIX version")));
});

test("markdown tables are parsed structurally, not by line matching", async () => {
  const { parseMarkdownTables } = await load();
  const tables = parseMarkdownTables(validationRecord());
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].headers, ["Artifact", "Version", "SHA-256", "Recorded"]);
  assert.equal(tables[0].rows.length, 2);
  assert.equal(tables[1].rows.length, 1);
});

test("the release metadata gate runs before packaging", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts["vscode:prepublish"], /check:release-metadata/u);
  assert.equal(fs.existsSync(path.join(root, "scripts", "check-release-metadata.mjs")), true);
});

test("a terminal row that names no staged artifact hash is refused at the artifact stage", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.compatibilityMatrix = input.compatibilityMatrix.replace(
    `| 2026-08-24 | \`${VSIX_HASH}\` | Pass |`,
    "| 2026-08-24 | — | Pass |",
  );
  const findings = releaseMetadataFindings(input);
  assert.ok(
    findings.some((finding) => finding.includes("names no staged artifact hash")),
    `a terminal row without provenance was accepted: ${findings.join("; ")}`,
  );
});

test("a record table with no SHA-256 column is refused at the artifact stage", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.providerTerms = input.providerTerms
    .replace("| Provider | Terms reviewed | Reviewer | Date | VSIX SHA-256 | Outcome |", "| Provider | Terms reviewed | Reviewer | Date | Outcome |")
    .replace("| --- | --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- |")
    .replace(`| Codex | Reviewed | operator | 2026-08-24 | \`${VSIX_HASH}\` | Permitted |`, "| Codex | Reviewed | operator | 2026-08-24 | Permitted |");
  const findings = releaseMetadataFindings(input);
  assert.ok(
    findings.some((finding) => finding.includes("record table with no SHA-256 column")),
    `a record table with no artifact column was accepted: ${findings.join("; ")}`,
  );
});

test("a hash recorded against the wrong artifact is refused", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.compatibilityMatrix = input.compatibilityMatrix.replace(
    `| 0.6.12 | 1.101.2 | Codex app server | 1.0.0 | macOS | HUMAN_E2E | 2026-08-24 | \`${VSIX_HASH}\` | Pass | none |`,
    `| 0.6.12 | 1.101.2 | Codex app server | 1.0.0 | macOS | HUMAN_E2E | 2026-08-24 | \`${BRIDGE_HASH}\` | Pass | none |`,
  );
  const findings = releaseMetadataFindings(input);
  assert.ok(
    findings.some((finding) => finding.includes("which is not the staged Bachata VSIX")),
    `the Bridge hash was accepted in a VSIX column: ${findings.join("; ")}`,
  );
});

test("a SHA-256 column that names no artifact is refused", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  input.providerTerms = input.providerTerms.replace("VSIX SHA-256", "Artifact SHA-256");
  assert.ok(
    releaseMetadataFindings(input).some((finding) => finding.includes("names no artifact")),
    "a generic hash column was accepted",
  );
});

test("a table that declares two artifacts requires both in every recorded row", async () => {
  const { releaseMetadataFindings } = await load();
  const input = completeInput();
  const dualHeader = "| OS | VS Code version | VSIX SHA-256 | Bridge SHA-256 | Date | Operator | Result | Notes |";
  const dualSeparator = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const withBridgeColumn = (bridgeCell) => input.validationRecord
    .replace(
      "| OS | VS Code version | VSIX SHA-256 | Date | Operator | Result | Notes |",
      dualHeader,
    )
    .replace("| --- | --- | --- | --- | --- | --- | --- |", dualSeparator)
    .replace(
      `| macOS | 1.101.2 | \`${VSIX_HASH}\` | 2026-08-24 | operator | Pass | none |`,
      `| macOS | 1.101.2 | \`${VSIX_HASH}\` | ${bridgeCell} | 2026-08-24 | operator | Pass | none |`,
    );

  const dualSchema = {
    ...fixtureSchemas(),
    "docs/RELEASE_VALIDATION_RECORD.md": [{
      headers: ["OS", "VS Code version", "VSIX SHA-256", "Bridge SHA-256", "Date", "Operator", "Result", "Notes"],
      rows: [{ OS: "macOS", "VS Code version": "1.101.2" }],
      requires: ["vsix", "bridge"],
    }],
  };
  const excused = completeInput();
  excused.schemas = dualSchema;
  excused.validationRecord = withBridgeColumn("not applicable");
  assert.ok(
    releaseMetadataFindings(excused).some((finding) => finding.includes("without a SHA-256")),
    "a declared artifact was excused with an unverifiable note",
  );

  const missing = completeInput();
  missing.schemas = dualSchema;
  missing.validationRecord = withBridgeColumn("—");
  assert.ok(
    releaseMetadataFindings(missing).some((finding) => finding.includes("without a SHA-256")),
    "a declared artifact was left unrecorded in a terminal row",
  );

  const complete = completeInput();
  complete.schemas = dualSchema;
  complete.validationRecord = withBridgeColumn(`\`${BRIDGE_HASH}\``);
  assert.deepEqual(releaseMetadataFindings(complete), []);
});

test("the required artifacts of every record table are fixed by this release, not by the document", async () => {
  const { releaseMetadataFindings, RECORD_SCHEMAS } = await load();
  const fs = require("node:fs");
  const path = require("node:path");
  const repository = path.join(__dirname, "..");
  const read = (relative) => fs.readFileSync(path.join(repository, relative), "utf8");
  const live = {
    packageJson: JSON.parse(read("package.json")),
    artifacts: artifacts(),
    stage: "artifact",
    validationRecord: read("docs/RELEASE_VALIDATION_RECORD.md"),
    providerTerms: read("docs/PROVIDER_TERMS.md"),
    compatibilityMatrix: read("docs/COMPATIBILITY_MATRIX.md"),
  };
  assert.deepEqual(
    Object.keys(RECORD_SCHEMAS).sort(),
    ["docs/COMPATIBILITY_MATRIX.md", "docs/PROVIDER_TERMS.md", "docs/RELEASE_VALIDATION_RECORD.md"],
  );
  assert.ok(
    Object.values(RECORD_SCHEMAS).some((tables) =>
      tables.some((table) => table.requires.includes("bridge"))),
    "no record table requires the Browser Bridge",
  );

  const downgraded = {
    ...live,
    compatibilityMatrix: live.compatibilityMatrix.replace(" | Bridge SHA-256", ""),
  };
  assert.ok(
    releaseMetadataFindings(downgraded).some((finding) => finding.includes("declares columns")),
    "removing a Bridge column from a browser table was accepted",
  );

  const truncated = {
    ...live,
    providerTerms: live.providerTerms.split("| Provider | VSIX SHA-256 | Bridge SHA-256")[0],
  };
  assert.ok(
    releaseMetadataFindings(truncated).some((finding) => finding.includes("record tables")),
    "dropping a whole record table was accepted",
  );
});

test("a completed dependency-audit row is accepted, not pinned to old prose", async () => {
  const { releaseMetadataFindings, RECORD_SCHEMAS } = await load();
  const fs = require("node:fs");
  const path = require("node:path");
  const repository = path.join(__dirname, "..");
  const read = (relative) => fs.readFileSync(path.join(repository, relative), "utf8");
  const live = {
    packageJson: JSON.parse(read("package.json")),
    artifacts: artifacts(),
    stage: "artifact",
    validationRecord: read("docs/RELEASE_VALIDATION_RECORD.md"),
    providerTerms: read("docs/PROVIDER_TERMS.md"),
    compatibilityMatrix: read("docs/COMPATIBILITY_MATRIX.md"),
  };
  const auditTable = RECORD_SCHEMAS["docs/RELEASE_VALIDATION_RECORD.md"].at(-1);
  assert.deepEqual(
    Object.keys(auditTable.rows[0]),
    ["Check"],
    "the schema pins evidence cells, so a legitimate completed result cannot be recorded",
  );

  const completed = {
    ...live,
    validationRecord: live.validationRecord.replace(
      "| Network-backed dependency audit | — | — | Not performed | — |",
      `| Network-backed dependency audit | 2026-08-25 | \`${VSIX_HASH}\` | Pass | 0 vulnerabilities |`,
    ),
  };
  assert.equal(
    releaseMetadataFindings(completed).some((finding) =>
      finding.includes("Network-backed dependency audit")),
    false,
    "a completed audit row with a real result was rejected",
  );
});

test("every compatibility table names the exact VS Code build a row was exercised on", async () => {
  const { RECORD_SCHEMAS, releaseMetadataFindings } = await load();
  RECORD_SCHEMAS["docs/COMPATIBILITY_MATRIX.md"].forEach((schema) => {
    assert.ok(
      schema.headers.includes("VS Code version"),
      `a compatibility table without a VS Code version column cannot record what it was tested on: ${schema.headers.join(" | ")}`,
    );
  });
  const document = fs.readFileSync(path.join(root, "docs", "COMPATIBILITY_MATRIX.md"), "utf8");
  const headerRows = document.split("\n").filter((line) => line.startsWith("| Extension |"));
  assert.ok(headerRows.length > 0, "the compatibility matrix declares tables");
  headerRows.forEach((line) => {
    assert.ok(line.includes("| VS Code version |"), `table header does not record the editor build: ${line}`);
  });

  const input = completeInput();
  input.compatibilityMatrix = input.compatibilityMatrix.replace(
    `| 0.6.12 | 1.101.2 | Codex app server | 1.0.0 | macOS | HUMAN_E2E | 2026-08-24 | \`${VSIX_HASH}\` | Pass | none |`,
    `| 0.6.12 | 1.101 | Codex app server | 1.0.0 | macOS | HUMAN_E2E | 2026-08-24 | \`${VSIX_HASH}\` | Pass | none |`,
  );
  const findings = releaseMetadataFindings(input);
  assert.ok(
    findings.some((finding) => finding.includes("without the exact VS Code build")),
    `a recorded row naming an inexact build must be refused: ${JSON.stringify(findings)}`,
  );

  const missing = completeInput();
  missing.compatibilityMatrix = missing.compatibilityMatrix.replace(
    `| 0.6.12 | 1.101.2 | Codex app server`,
    `| 0.6.12 | — | Codex app server`,
  );
  assert.ok(
    releaseMetadataFindings(missing).some((finding) => finding.includes("without the exact VS Code build")),
    "a recorded row with no build at all must be refused",
  );
});
