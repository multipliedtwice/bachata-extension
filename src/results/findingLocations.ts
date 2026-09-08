import * as path from "node:path";

import { pathInsideRelative } from "../process/pathBoundary";
import type { RunResultCenter } from "./projectResult";

export type RunFindingSeverity = "error" | "warning" | "information";
export type RunFindingSource = "check" | "gap" | "modelFinding";

export type RunFinding = {
  message: string;
  severity: RunFindingSeverity;
  source: RunFindingSource;
  file?: string;
  startLine?: number;
  endLine?: number;
};

const LOCATION = /(?:^|[\s(`"'[])((?:\.{0,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z][\w]{0,15}):(\d{1,7})(?:[:-](\d{1,7}))?/u;

export const parseFindingLocation = (
  text: string,
): { file: string; startLine: number; endLine: number } | undefined => {
  const match = LOCATION.exec(text);
  if (!match) return undefined;
  const file = match[1];
  const startLine = Number(match[2]);
  const endLine = match[3] === undefined ? startLine : Number(match[3]);
  if (file === undefined || !Number.isInteger(startLine) || startLine < 1) return undefined;
  return {
    file,
    startLine,
    endLine: Number.isInteger(endLine) && endLine >= startLine ? endLine : startLine,
  };
};

const finding = (
  message: string,
  severity: RunFindingSeverity,
  source: RunFindingSource,
): RunFinding => {
  const trimmed = message.trim();
  const location = parseFindingLocation(trimmed);
  return {
    message: trimmed,
    severity,
    source,
    ...(location === undefined
      ? {}
      : { file: location.file, startLine: location.startLine, endLine: location.endLine }),
  };
};

export const runFindings = (result: RunResultCenter): RunFinding[] => [
  ...result.checks
    .filter((check) => check.status === "failed" || check.status === "timedOut")
    .map((check) => finding(`${check.command} ${check.status}`, "error", "check")),
  ...(result.findings ?? [])
    .filter((item) => item.disposition === "accepted")
    .map((item): RunFinding => ({
      message: item.message,
      severity: item.severity ?? "warning",
      source: "modelFinding",
      ...(item.location === undefined
        ? {}
        : {
            file: item.location.file,
            ...(item.location.startLine === undefined ? {} : { startLine: item.location.startLine }),
            ...(item.location.endLine === undefined ? {} : { endLine: item.location.endLine }),
          }),
    })),
  ...result.evidence
    .filter((entry) => entry.state === "missing")
    .map((entry) => finding(`${entry.label}: ${entry.detail}`, "information", "gap")),
];

export const groupFindingsByFile = (
  findings: RunFinding[],
  workingDirectory: string,
): { located: Map<string, RunFinding[]>; unlocated: RunFinding[] } => {
  const located = new Map<string, RunFinding[]>();
  const unlocated: RunFinding[] = [];
  findings.forEach((item) => {
    if (item.file === undefined) {
      unlocated.push(item);
      return;
    }
    const absolute = path.isAbsolute(item.file)
      ? path.normalize(item.file)
      : path.resolve(workingDirectory, item.file);
    if (pathInsideRelative(workingDirectory, absolute) === undefined) {
      unlocated.push(item);
      return;
    }
    located.set(absolute, [...(located.get(absolute) ?? []), item]);
  });
  return { located, unlocated };
};
