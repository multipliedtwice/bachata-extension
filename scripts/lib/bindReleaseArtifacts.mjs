import { RECORD_SCHEMAS, schemaFindings } from "./releaseMetadata.mjs";

export const BINDING_DOCUMENTS = [
  "docs/RELEASE_VALIDATION_RECORD.md",
  "docs/PROVIDER_TERMS.md",
  "docs/COMPATIBILITY_MATRIX.md",
  "docs/RELEASE_VERDICT.md",
];

export const RECORD_DOCUMENTS = new Set([
  "docs/RELEASE_VALIDATION_RECORD.md",
  "docs/PROVIDER_TERMS.md",
  "docs/COMPATIBILITY_MATRIX.md",
]);

const RESULT_HEADER = /^(?:result|outcome|suite result|terms reviewed)$/iu;
const HASH_HEADER = /sha-?256/iu;
const VERSION_HEADER = /version/iu;
const RECORDED_HEADER = /recorded/iu;
const ARTIFACT_HEADER = /artifact/iu;

const EMPTY_CELLS = new Set(["", "-", "—", "–", "n/a", "na", "tbd", "?", "…"]);
const UNRECORDED_VALUES = new Set([
  "not performed",
  "not tested",
  "not reviewed",
  "not run",
  "pending",
]);

const DESCRIPTOR_HEADER =
  /^(?:os|vs code version|node version|git version|provider|provider version|adapter|extension|bridge|browser|runtime|model|checklist|step|scenario|check|integration mode)$/iu;

export const isDescriptorHeader = (header) => DESCRIPTOR_HEADER.test(header.trim());

const unrecordedFor = (header) => /^terms reviewed$/iu.test(header.trim())
  ? "Not reviewed"
  : RESULT_HEADER.test(header.trim())
    ? "Not performed"
    : "—";

const isSeparator = (line) => /^\|[\s:|-]+\|?\s*$/u.test(line.trim()) && line.includes("-");

const splitCells = (line) => {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined);
  return inner.split("|").map((cell) => cell.trim());
};

const joinCells = (values) => `| ${values.join(" | ")} |`;

export const bindingLine = (artifacts) =>
  `Artifacts under test: Bachata VSIX \`${artifacts.vsix.sha256}\`, Browser Bridge ZIP \`${artifacts.bridge.sha256}\`.`;

const rewriteArtifactRow = (artifacts, headers, cells) => {
  const artifact = Object.values(artifacts).find(
    (candidate) => candidate.label.toLowerCase() === (cells[0] ?? "").toLowerCase(),
  );
  if (!artifact) return cells;
  return cells.map((cell, index) => {
    const header = headers[index] ?? "";
    if (HASH_HEADER.test(header)) return `\`${artifact.sha256}\``;
    if (VERSION_HEADER.test(header)) return artifact.version;
    if (RECORDED_HEADER.test(header)) return "yes";
    return cell;
  });
};

const resetRow = (headers, cells) =>
  cells.map((cell, index) => (
    index === 0 || isDescriptorHeader(headers[index] ?? "")
      ? cell
      : unrecordedFor(headers[index] ?? "")
  ));

const parseTables = (lines) => {
  const tables = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trimStart().startsWith("|") && !isSeparator(line) &&
      index + 1 < lines.length && isSeparator(lines[index + 1])) {
      const headers = splitCells(line);
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trimStart().startsWith("|")) {
        rows.push({ cells: splitCells(lines[cursor]), line: cursor + 1 });
        cursor += 1;
      }
      tables.push({ headers, rows });
      index = cursor;
      continue;
    }
    index += 1;
  }
  return tables;
};

export const planDocumentBinding = ({
  relative,
  original,
  artifacts,
  voidUnbindable = false,
  schemas = RECORD_SCHEMAS,
}) => {
  const voidsRows = RECORD_DOCUMENTS.has(relative);
  const currentHashes = new Set([artifacts.vsix.sha256, artifacts.bridge.sha256]);
  const lines = original.split("\n");
  const problems = [];
  if (schemas[relative]) {
    schemaFindings({
      findings: problems,
      label: relative,
      recordTables: parseTables(lines).filter((table) => table.headers.some(
        (header) => RESULT_HEADER.test(header),
      )),
      schemas,
    });
  }
  const unbindable = [];
  let voided = 0;
  let headers;
  let resultColumn = -1;
  let inArtifactTable = false;
  let bindingLines = 0;

  const next = lines.map((line, index) => {
    if (/^Artifacts?\s+under\s+test:/iu.test(line.trim())) {
      bindingLines += 1;
      return bindingLine(artifacts);
    }
    if (!line.trimStart().startsWith("|")) {
      headers = undefined;
      resultColumn = -1;
      inArtifactTable = false;
      return line;
    }
    if (isSeparator(line)) return line;
    if (!headers) {
      headers = splitCells(line);
      resultColumn = headers.findIndex((header) => RESULT_HEADER.test(header));
      inArtifactTable = ARTIFACT_HEADER.test(headers[0] ?? "");
      return line;
    }
    const cells = splitCells(line);
    if (cells.length !== headers.length) {
      problems.push(
        `${relative}:${String(index + 1)} has ${String(cells.length)} cells but its table declares ${String(headers.length)} columns`,
      );
      return line;
    }
    if (inArtifactTable) return joinCells(rewriteArtifactRow(artifacts, headers, cells));
    if (!voidsRows || resultColumn < 0) return line;
    const verdict = (cells[resultColumn] ?? "").trim().toLowerCase();
    if (EMPTY_CELLS.has(verdict) || UNRECORDED_VALUES.has(verdict)) return line;
    const hashColumns = headers.flatMap((header, column) => HASH_HEADER.test(header) ? [column] : []);
    const cellHashes = hashColumns.map((column) => ({
      header: headers[column] ?? "",
      value: (cells[column] ?? "").replace(/`/gu, "").trim().toLowerCase(),
    }));
    const stale = cellHashes.some((entry) => /^[0-9a-f]{64}$/u.test(entry.value) &&
      !currentHashes.has(entry.value));
    if (stale) {
      voided += 1;
      return joinCells(resetRow(headers, cells));
    }
    const unnamed = hashColumns.length === 0 ||
      cellHashes.some((entry) => !currentHashes.has(entry.value));
    if (unnamed) {
      if (voidUnbindable) {
        voided += 1;
        return joinCells(resetRow(headers, cells));
      }
      unbindable.push(
        `${relative}:${String(index + 1)} ${cells[0] || "unnamed row"}${
          hashColumns.length === 0
            ? " (its table declares no artifact column)"
            : ` (${cellHashes.filter((entry) => !currentHashes.has(entry.value)).map((entry) => entry.header).join(", ")} is not a staged artifact hash)`
        }`,
      );
    }
    return line;
  }).join("\n");

  if (bindingLines === 0) {
    problems.push(`${relative} declares no "Artifacts under test:" line to bind`);
  }
  return { next, problems, unbindable, voided };
};
