import * as vscode from "vscode";

import { groupFindingsByFile, runFindings } from "./findingLocations";
import type { RunFinding } from "./findingLocations";
import type { RunResultCenter } from "./projectResult";

const severity = (value: RunFinding["severity"]): vscode.DiagnosticSeverity =>
  value === "error"
    ? vscode.DiagnosticSeverity.Error
    : value === "warning"
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;

export type PublishedFindings = {
  located: number;
  unlocated: number;
};

export const publishRunFindings = (
  collection: vscode.DiagnosticCollection,
  result: RunResultCenter | undefined,
  workingDirectory: string | undefined,
): PublishedFindings => {
  collection.clear();
  if (!result || workingDirectory === undefined) return { located: 0, unlocated: 0 };
  const grouped = groupFindingsByFile(runFindings(result), workingDirectory);
  grouped.located.forEach((findings, file) => {
    collection.set(
      vscode.Uri.file(file),
      findings.map((finding) => {
        const line = Math.max(0, (finding.startLine ?? 1) - 1);
        const endLine = Math.max(line, (finding.endLine ?? finding.startLine ?? 1) - 1);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, 0, endLine, Number.MAX_SAFE_INTEGER),
          finding.message,
          severity(finding.severity),
        );
        diagnostic.source = "Bachata";
        diagnostic.code = `bachata.${finding.source}`;
        return diagnostic;
      }),
    );
  });
  let located = 0;
  grouped.located.forEach((findings) => {
    located += findings.length;
  });
  return { located, unlocated: grouped.unlocated.length };
};
