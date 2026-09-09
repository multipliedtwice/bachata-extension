import { ownerPublicationApproved } from "./ownerPublicationApproval.mjs";

export const PLACEHOLDER_MARKER = "todo-release";

const placeholder = (value) =>
  typeof value !== "string" || value.trim().length === 0 ||
  value.toLowerCase().includes(PLACEHOLDER_MARKER);

const httpsUrl = (value) => typeof value === "string" && /^https:\/\/[^\s]+$/u.test(value);

const requireUrl = (findings, label, value) => {
  if (placeholder(value)) {
    findings.push(`${label} is a placeholder or missing: set the real value before publishing.`);
    return;
  }
  if (!httpsUrl(value)) findings.push(`${label} must be an https URL.`);
};

const EMPTY_CELLS = new Set(["", "-", "—", "–", "n/a", "na", "tbd", "?", "…"]);
const UNRECORDED = new Set(["not performed", "not tested", "not reviewed", "not run", "pending"]);
const TERMINAL_RESULTS = new Set([
  "pass", "fail", "blocked", "not applicable",
  "reviewed", "permitted", "refused", "restricted",
]);

export const isIsoDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
};

export const isSha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value.trim());

const cells = (line) => {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined);
  return inner.split("|").map((cell) => cell.trim());
};

const isSeparator = (line) => /^\|[\s:|-]+\|?\s*$/u.test(line.trim()) && line.includes("-");

export const parseMarkdownTables = (document) => {
  const lines = typeof document === "string" ? document.split("\n") : [];
  const tables = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trimStart().startsWith("|") && !isSeparator(line) &&
      index + 1 < lines.length && isSeparator(lines[index + 1])) {
      const headers = cells(line);
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trimStart().startsWith("|")) {
        rows.push({ cells: cells(lines[cursor]), line: cursor + 1 });
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

const columnIndexes = (headers, pattern) =>
  headers.flatMap((header, index) => pattern.test(header) ? [index] : []);

const emptyCell = (value) => EMPTY_CELLS.has(value.trim().toLowerCase());

const unrecordedCell = (value) => UNRECORDED.has(value.trim().toLowerCase());

const rowLabel = (table, row) => {
  const first = row.cells[0] ?? "";
  return emptyCell(first) ? `row ${String(row.line)}` : `"${first}"`;
};

const structuredTableFindings = ({
  findings,
  label,
  table,
  artifactHashes,
  artifactHashByKind = {},
  checksEvidence = true,
  deferredManualColumns = [],
}) => {
  const bindsArtifacts = artifactHashes !== undefined;
  const dateColumns = columnIndexes(table.headers, /date/iu);
  const resultColumns = columnIndexes(table.headers, /^(?:result|outcome|suite result|terms reviewed)$/iu);
  const hashColumns = columnIndexes(table.headers, /sha-?256/iu);
  const artifactKindFor = (header) => /\bvsix\b/iu.test(header)
    ? "vsix"
    : /\bbridge\b/iu.test(header)
      ? "bridge"
      : undefined;
  if (bindsArtifacts && resultColumns.length > 0) {
    if (hashColumns.length === 0) {
      findings.push(
        `${label} has a record table with no SHA-256 column, so its rows name no artifact: ${table.headers.join(" | ")}.`,
      );
    }
    hashColumns
      .filter((index) => artifactKindFor(table.headers[index] ?? "") === undefined)
      .forEach((index) => findings.push(
        `${label} has a SHA-256 column that names no artifact: "${table.headers[index]}". Use "VSIX SHA-256" or "Bridge SHA-256" so a hash cannot be recorded against the wrong artifact.`,
      ));
  }
  const editorColumns = columnIndexes(table.headers, /^vs code version$/iu);
  // A row is evidence for the editor build it was exercised on. A recorded row that names
  // no exact build, or names only a range, proves nothing about any particular VS Code.
  const editorVersionFindings = (row, where) => {
    if (editorColumns.length === 0 || resultColumns.length === 0) return;
    const recorded = resultColumns.some((index) => {
      const value = row.cells[index] ?? "";
      return !emptyCell(value) && !unrecordedCell(value);
    });
    if (!recorded) return;
    editorColumns.forEach((index) => {
      const value = (row.cells[index] ?? "").replace(/`/gu, "").trim();
      if (/^\d+\.\d+\.\d+$/u.test(value)) return;
      findings.push(
        `${where} records a result without the exact VS Code build it ran on in ${table.headers[index]}: "${value}". Record the version from Code > About, for example 1.101.2.`,
      );
    });
  };

  const artifactProvenanceFindings = (row, where) => {
    if (!bindsArtifacts || resultColumns.length === 0) return;
    const recorded = resultColumns.some((index) => {
      const value = row.cells[index] ?? "";
      return !emptyCell(value) && !unrecordedCell(value);
    });
    if (!recorded) return;
    let named = false;
    hashColumns.forEach((index) => {
      const header = table.headers[index] ?? "";
      const kind = artifactKindFor(header);
      const value = (row.cells[index] ?? "").replace(/`/gu, "").trim();
      if (!isSha256(value)) {
        findings.push(
          `${where} leaves ${header} without a SHA-256. Every artifact its table declares must be named, so a table records only the artifacts its rows actually depend on: "${value}".`,
        );
        return;
      }
      const expected = kind === undefined ? undefined : artifactHashByKind[kind];
      if (expected === undefined) return;
      if (value.toLowerCase() !== expected) {
        findings.push(
          `${where} records ${value.slice(0, 12)}… in ${header}, which is not the staged ${kind === "vsix" ? "Bachata VSIX" : "Browser Bridge ZIP"}.`,
        );
        return;
      }
      named = true;
    });
    if (!named) {
      findings.push(
        `${where} records a terminal result but names no staged artifact hash, so it proves nothing about the staged artifacts.`,
      );
    }
  };

  table.rows.forEach((row) => {
    const where = `${label} ${rowLabel(table, row)}`;
    if (row.cells.length !== table.headers.length) {
      findings.push(`${where} has ${String(row.cells.length)} cells but the table declares ${String(table.headers.length)} columns.`);
      return;
    }
    const unrecorded = row.cells.filter(unrecordedCell);
    if (unrecorded.length > 0) {
      const authorizedManualDeferral = row.cells.every((cell, index) =>
        !unrecordedCell(cell) || deferredManualColumns.includes(table.headers[index]));
      if (checksEvidence && !authorizedManualDeferral) {
        findings.push(`${where} is still unrecorded ("${unrecorded[0]}").`);
      }
      return;
    }
    const empty = row.cells.flatMap((cell, index) => {
      if (!emptyCell(cell)) return [];
      const header = table.headers[index] || `column ${String(index + 1)}`;
      if (!bindsArtifacts && /sha-?256/iu.test(header)) return [];
      return [header];
    });
    if (checksEvidence && empty.length > 0) {
      findings.push(`${where} leaves ${String(empty.length)} required cell(s) empty: ${empty.join(", ")}.`);
    }
    if (!checksEvidence) {
      artifactProvenanceFindings(row, where);
      editorVersionFindings(row, where);
      hashColumns.forEach((index) => {
        const value = row.cells[index].replace(/`/gu, "").trim();
        if (emptyCell(value)) return;
        if (!isSha256(value)) {
          findings.push(`${where} does not name a SHA-256 in ${table.headers[index]}: "${value}".`);
          return;
        }
        if (bindsArtifacts && !artifactHashes.includes(value.toLowerCase())) {
          findings.push(`${where} names ${value.slice(0, 12)}… which is not a staged release artifact hash.`);
        }
      });
      return;
    }
    dateColumns.forEach((index) => {
      const value = row.cells[index];
      if (!emptyCell(value) && !isIsoDate(value)) {
        findings.push(`${where} has an invalid ${table.headers[index]}: "${value}" is not an ISO YYYY-MM-DD date.`);
      }
    });
    resultColumns.forEach((index) => {
      const value = row.cells[index];
      if (!emptyCell(value) && !TERMINAL_RESULTS.has(value.trim().toLowerCase())) {
        findings.push(`${where} has a ${table.headers[index]} that is not a terminal verdict: "${value}".`);
      }
    });
    artifactProvenanceFindings(row, where);
    editorVersionFindings(row, where);
    hashColumns.forEach((index) => {
      const value = row.cells[index].replace(/`/gu, "").trim();
      if (emptyCell(value)) return;
      if (!isSha256(value)) {
        findings.push(`${where} does not name a SHA-256 in ${table.headers[index]}: "${value}".`);
        return;
      }
      if (bindsArtifacts && !artifactHashes.includes(value.toLowerCase())) {
        findings.push(`${where} names ${value.slice(0, 12)}… which is not a staged release artifact hash.`);
      }
    });
  });
};

const BINDING_PATTERN = /artifacts?\s+under\s+test:(.*)/iu;

const bindingFindings = ({ findings, label, document, artifacts }) => {
  const match = typeof document === "string" ? BINDING_PATTERN.exec(document) : undefined;
  if (!match) {
    findings.push(`${label} states no "Artifacts under test:" binding line, so its records are not bound to a staged artifact.`);
    return;
  }
  const declared = Array.from(match[1].matchAll(/[0-9a-f]{64}/giu), (item) => item[0].toLowerCase());
  [["Bachata VSIX", artifacts.vsix], ["Browser Bridge ZIP", artifacts.bridge]].forEach(([name, artifact]) => {
    if (!artifact?.sha256) return;
    if (!declared.includes(artifact.sha256.toLowerCase())) {
      findings.push(`${label} does not bind its records to the staged ${name} SHA-256 ${artifact.sha256.slice(0, 12)}….`);
    }
  });
};

const artifactTableFindings = ({ findings, tables, artifacts, label }) => {
  const table = tables.find((candidate) =>
    /artifact/iu.test(candidate.headers[0] ?? "") && columnIndexes(candidate.headers, /sha-?256/iu).length > 0);
  if (!table) {
    findings.push(`${label} has no "Artifacts under test" table naming the exact artifact hashes.`);
    return;
  }
  [["Bachata VSIX", artifacts.vsix], ["Browser Bridge ZIP", artifacts.bridge]].forEach(([name, artifact]) => {
    if (!artifact) {
      findings.push(`${label} cannot be verified: the staged ${name} was not found.`);
      return;
    }
    const versionColumn = columnIndexes(table.headers, /version/iu)[0];
    const hashColumn = columnIndexes(table.headers, /sha-?256/iu)[0];
    const row = table.rows.find((candidate) => candidate.cells[0]?.toLowerCase() === name.toLowerCase());
    if (!row) {
      findings.push(`${label} has no artifact row named "${name}".`);
      return;
    }
    const declaredHash = (row.cells[hashColumn] ?? "").replace(/`/gu, "").trim().toLowerCase();
    if (declaredHash !== artifact.sha256.toLowerCase()) {
      findings.push(`${label} records ${name} as ${declaredHash || "no hash"}, but the staged artifact is ${artifact.sha256.slice(0, 12)}….`);
    }
    const declaredVersion = (row.cells[versionColumn] ?? "").trim();
    if (versionColumn !== undefined && declaredVersion !== artifact.version) {
      findings.push(`${label} records ${name} version "${declaredVersion}", but the staged artifact is ${artifact.version}.`);
    }
  });
};

export const RECORD_SCHEMAS = {
  "docs/RELEASE_VALIDATION_RECORD.md": [
    {
      headers: ["OS", "VS Code version", "VSIX SHA-256", "Date", "Operator", "Result", "Notes"],
      requires: ["vsix"],
      rows: [
        {"OS": "macOS"},
        {"OS": "Linux"},
        {"OS": "Windows"},
      ],
    },
    {
      headers: ["Provider", "Provider build seen", "Auth state", "Date", "VSIX SHA-256", "Result", "Completion detection", "Interruption", "Conversation continuity", "Notes"],
      requires: ["vsix"],
      rows: [
        {"Provider": "Codex app server"},
        {"Provider": "Claude Code"},
        {"Provider": "Z.AI GLM"},
      ],
    },
    {
      headers: ["Provider", "Provider build seen", "Auth state", "Date", "VSIX SHA-256", "Bridge SHA-256", "Result", "Completion detection", "Interruption", "Conversation continuity", "Notes"],
      requires: ["vsix", "bridge"],
      rows: [
        {"Provider": "ChatGPT browser"},
        {"Provider": "Claude browser"},
        {"Provider": "Generic browser target"},
      ],
    },
    {
      headers: ["Step", "Date", "VSIX SHA-256", "Bridge SHA-256", "Result", "Notes"],
      requires: ["vsix", "bridge"],
      rows: [
        {"Step": "Install from verified ZIP"},
        {"Step": "Pair with the local endpoint"},
        {"Step": "Reconnect after bridge restart"},
        {"Step": "Tab refresh keeps the binding"},
        {"Step": "Interruption stops the running turn"},
        {"Step": "Completion detection on a long answer"},
        {"Step": "Stale binding recovery after tab close"},
      ],
    },
    {
      headers: ["OS", "Node version", "Git version", "VSIX SHA-256", "Suite result", "Skipped tests", "Graphical checklist", "Date", "Result"],
      requires: ["vsix"],
      rows: [
        {"OS": "macOS"},
        {"OS": "Linux"},
        {"OS": "Windows"},
      ],
    },
    {
      headers: ["Scenario", "Date", "VSIX SHA-256", "Result", "Longest blocked interval", "Notes"],
      requires: ["vsix"],
      rows: [
        {"Scenario": "Graphical cold start on a large state file"},
        {"Scenario": "Two VS Code windows contending for one repository"},
        {"Scenario": "Lock timeout and recovery"},
        {"Scenario": "State recovery after a forced Extension Host restart"},
      ],
    },
    {
      headers: ["Check", "Date", "VSIX SHA-256", "Result", "Notes"],
      requires: ["vsix"],
      rows: [
        {"Check": "Network-backed dependency audit"},
      ],
    },
  ],
  "docs/PROVIDER_TERMS.md": [
    {
      headers: ["Provider", "VSIX SHA-256", "Terms reviewed", "Reviewer", "Date", "Outcome"],
      requires: ["vsix"],
      rows: [
        {"Provider": "Codex"},
        {"Provider": "Claude Code"},
        {"Provider": "Z.AI GLM"},
        {"Provider": "Local model endpoint"},
      ],
    },
    {
      headers: ["Provider", "VSIX SHA-256", "Bridge SHA-256", "Terms reviewed", "Reviewer", "Date", "Outcome"],
      requires: ["vsix", "bridge"],
      rows: [
        {"Provider": "ChatGPT"},
        {"Provider": "Claude"},
        {"Provider": "Generic browser target"},
      ],
    },
  ],
  "docs/COMPATIBILITY_MATRIX.md": [
    {
      headers: ["Extension", "VS Code version", "Provider", "Provider version", "OS", "Checklist", "Date", "VSIX SHA-256", "Result", "Known limitations"],
      requires: ["vsix"],
      rows: [
        {"Extension": "0.7.0", "Provider": "Codex app server", "OS": "macOS", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Provider": "Codex app server", "OS": "Linux", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Provider": "Codex app server", "OS": "Windows", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Provider": "Claude Code", "OS": "macOS", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Provider": "Claude Code", "OS": "Linux", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Provider": "Claude Code", "OS": "Windows", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Provider": "Z.AI GLM", "OS": "macOS", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Provider": "Z.AI GLM", "OS": "Linux", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Provider": "Z.AI GLM", "OS": "Windows", "Checklist": "HUMAN_E2E + LIVE_SMOKE_TEST"},
      ],
    },
    {
      headers: ["Extension", "VS Code version", "Bridge", "Provider", "Browser", "OS", "Checklist", "Date", "VSIX SHA-256", "Bridge SHA-256", "Result", "Known limitations"],
      requires: ["vsix", "bridge"],
      rows: [
        {"Extension": "0.7.0", "Bridge": "0.6.7", "Provider": "ChatGPT", "Browser": "Chrome", "OS": "macOS", "Checklist": "LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Bridge": "0.6.7", "Provider": "ChatGPT", "Browser": "Edge", "OS": "Windows", "Checklist": "LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Bridge": "0.6.7", "Provider": "Claude", "Browser": "Chrome", "OS": "macOS", "Checklist": "LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Bridge": "0.6.7", "Provider": "Claude", "Browser": "Edge", "OS": "Windows", "Checklist": "LIVE_SMOKE_TEST"},
        {"Extension": "0.7.0", "Bridge": "0.6.7", "Provider": "Generic target", "Browser": "Chrome", "OS": "macOS", "Checklist": "LIVE_SMOKE_TEST"},
      ],
    },
    {
      headers: ["Extension", "VS Code version", "Runtime", "Model", "OS", "Checklist", "Date", "VSIX SHA-256", "Result", "Known limitations"],
      requires: ["vsix"],
      rows: [
        {"Extension": "0.7.0", "Checklist": "SEMANTIC_INTERPRETER fixtures"},
      ],
    },
  ],
};

export const schemaFindings = ({ findings, label, recordTables, schemas }) => {
  const schema = schemas[label];
  if (!schema) return;
  if (recordTables.length !== schema.length) {
    findings.push(
      `${label} declares ${String(recordTables.length)} record tables, but this release requires exactly ${String(schema.length)}. A record document cannot add, drop, or reorder a record table.`,
    );
    return;
  }
  recordTables.forEach((table, index) => {
    const expected = schema[index];
    const where = `${label} record table ${String(index + 1)}`;
    if (table.headers.join(" | ") !== expected.headers.join(" | ")) {
      findings.push(
        `${where} declares columns "${table.headers.join(" | ")}", but this release requires exactly "${expected.headers.join(" | ")}".`,
      );
      return;
    }
    if (table.rows.length !== expected.rows.length) {
      findings.push(
        `${where} records ${String(table.rows.length)} rows, but this release requires exactly ${String(expected.rows.length)}. A record document cannot add or drop a required row.`,
      );
      return;
    }
    table.rows.forEach((row, rowIndex) => {
      const required = expected.rows[rowIndex];
      const wrong = Object.entries(required).flatMap(([header, value]) => {
        const column = table.headers.indexOf(header);
        const observed = (row.cells[column] ?? "").trim();
        return observed === value ? [] : [`${header} is "${observed}", not "${value}"`];
      });
      if (wrong.length > 0) {
        findings.push(
          `${where} row ${String(rowIndex + 1)} is not the record this release requires: ${wrong.join("; ")}. A record document cannot rename, reorder, or substitute a required row.`,
        );
      }
    });
  });
};

export const releaseMetadataFindings = ({
  packageJson,
  readme = "",
  screenshotFiles = [],
  bridgeInstallDocument,
  validationRecord,
  providerTerms,
  compatibilityMatrix,
  providerDocumentationSource = "",
  artifacts = {},
  stage = "all",
  schemas = RECORD_SCHEMAS,
  publicationVerdict,
  publicationTarget = "both",
}) => {
  const findings = [];
  const stages = stage === "all"
    ? { identity: true, evidence: true, artifact: true }
    : stage === "source"
      ? { identity: true, evidence: true, artifact: false }
      : {
          identity: stage === "identity",
          evidence: stage === "evidence",
          artifact: stage === "artifact",
        };
  const bindsArtifacts = stages.artifact;
  let approvedManualDeferral = false;
  if (stages.evidence && bindsArtifacts) {
    try {
      approvedManualDeferral = ownerPublicationApproved(publicationVerdict, artifacts, publicationTarget);
    } catch (error) {
      findings.push(error.message);
    }
  }

  if (stages.identity) {
  if (placeholder(packageJson.publisher) || packageJson.publisher === "local") {
    findings.push("publisher is a placeholder: set the real Marketplace publisher identity.");
  }
  if (packageJson.displayName !== "Bachata") {
    findings.push('displayName must be the canonical product name "Bachata".');
  }
  if (typeof packageJson.description !== "string" || packageJson.description.trim().length < 40) {
    findings.push("description must state what the extension does in one full sentence.");
  }
  if (typeof packageJson.license !== "string" || packageJson.license.trim().length === 0) {
    findings.push("license is missing.");
  }
  requireUrl(findings, "repository.url", packageJson.repository?.url);
  requireUrl(findings, "homepage", packageJson.homepage);
  requireUrl(findings, "bugs.url", packageJson.bugs?.url);
  requireUrl(findings, "qna", packageJson.qna);
  if (packageJson.sponsor !== undefined) {
    requireUrl(findings, "sponsor.url", packageJson.sponsor?.url);
  }

  if (artifacts.vsix && packageJson.version !== artifacts.vsix.version) {
    findings.push(`package.json version ${String(packageJson.version)} does not match the staged VSIX version ${artifacts.vsix.version}.`);
  }


  if (typeof bridgeInstallDocument !== "string" || bridgeInstallDocument.trim().length === 0) {
    findings.push("docs/BROWSER_BRIDGE_INSTALL.md is missing.");
  } else {
    const downloads = Array.from(
      bridgeInstallDocument.matchAll(/https:\/\/[^\s)]+/gu),
      (match) => match[0],
    );
    if (downloads.length === 0 || downloads.every((url) => placeholder(url))) {
      findings.push("docs/BROWSER_BRIDGE_INSTALL.md has no real public Browser Bridge acquisition URL.");
    }
  }

  const placeholderDocumentationUrls = Array.from(
    providerDocumentationSource.matchAll(/https:\/\/[^\s"']+/gu),
    (match) => match[0],
  ).filter((url) => placeholder(url));
  if (placeholderDocumentationUrls.length > 0) {
    findings.push(
      `src/readiness/providerDocs.ts still has ${String(placeholderDocumentationUrls.length)} placeholder documentation URLs.`,
    );
  }
  }

  const artifactHashes = bindsArtifacts
    ? [artifacts.vsix?.sha256, artifacts.bridge?.sha256]
      .filter((value) => typeof value === "string")
      .map((value) => value.toLowerCase())
    : undefined;

  if (stages.evidence) {
    const referencedScreenshots = Array.from(
      readme.matchAll(/!\[[^\]]*\]\((media\/screenshots\/[^)\s]+)\)/gu),
      (match) => match[1],
    );
    if (referencedScreenshots.length === 0 && !approvedManualDeferral) {
      findings.push("README.md references no screenshot under media/screenshots/.");
    }
    referencedScreenshots
      .filter((reference) => !screenshotFiles.includes(reference))
      .forEach((reference) => findings.push(`README.md references a missing screenshot: ${reference}`));
    if (screenshotFiles.length === 0 && !approvedManualDeferral) {
      findings.push("media/screenshots/ contains no verified screenshot of the packaged build.");
    }
  }

  const structuredDocument = (document, label, options = {}) => {
    if (!stages.evidence && !stages.artifact) return;
    if (typeof document !== "string" || document.trim().length === 0) {
      findings.push(`${label} is missing.`);
      return;
    }
    const tables = parseMarkdownTables(document);
    if (tables.length === 0) {
      findings.push(`${label} declares no record table.`);
      return;
    }
    if (bindsArtifacts) {
      bindingFindings({ findings, label, document, artifacts });
      if (options.artifactTable) {
        artifactTableFindings({ findings, tables, artifacts, label });
      }
    }
    if (!stages.evidence && !stages.artifact) return;
    const recordTables = tables
      .filter((table) => !(options.artifactTable && /artifact/iu.test(table.headers[0] ?? "")))
      .filter((table) => !(options.skipHeader && options.skipHeader.test(table.headers.join(" | "))))
      .filter((table) => table.headers.some(
        (header) => /^(?:result|outcome|suite result|terms reviewed)$/iu.test(header),
      ));
    if (stages.artifact) {
      schemaFindings({ findings, label, recordTables, schemas });
    }
    tables
      .filter((table) => !(options.artifactTable && /artifact/iu.test(table.headers[0] ?? "")))
      .filter((table) => !(options.skipHeader && options.skipHeader.test(table.headers.join(" | "))))
      .forEach((table) => structuredTableFindings({
        findings,
        label,
        table,
        artifactHashes,
        artifactHashByKind: {
          ...(artifacts.vsix?.sha256 ? { vsix: artifacts.vsix.sha256.toLowerCase() } : {}),
          ...(artifacts.bridge?.sha256 ? { bridge: artifacts.bridge.sha256.toLowerCase() } : {}),
        },
        checksEvidence: stages.evidence,
        deferredManualColumns: !approvedManualDeferral ? []
          : label === "docs/PROVIDER_TERMS.md" ? ["Terms reviewed", "Outcome"]
            : label === "docs/COMPATIBILITY_MATRIX.md" ? ["Result"]
              : label === "docs/RELEASE_VALIDATION_RECORD.md"
                && ["OS", "Provider", "Step", "Scenario"].includes(table.headers[0])
                ? ["Result", "Graphical checklist"] : [],
      }));
  };

  structuredDocument(validationRecord, "docs/RELEASE_VALIDATION_RECORD.md", { artifactTable: true });
  structuredDocument(providerTerms, "docs/PROVIDER_TERMS.md", {
    skipHeader: /Integration mode/iu,
  });
  structuredDocument(compatibilityMatrix, "docs/COMPATIBILITY_MATRIX.md");

  return findings;
};
