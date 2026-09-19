import type { CapturedSegment } from "./protocol";

export type RequestEvidence = {
  start: number;
  end: number;
  text: string;
  segmentType: CapturedSegment["type"];
  fenced: boolean;
  quoted: boolean;
  example: boolean;
  contextBefore: string;
  contextAfter: string;
  eligible: boolean;
};

const exampleIntroduction = (line: string): boolean =>
  /^\s*(?:examples?|for example|the (?:worker|lead|user|assistant) said|quoted?(?: text)?|note)\s*:/i.test(line)
  || /\b(?:not|isn['’]t|is not)\s+an?\s+(?:instruction|request|action)\b/i.test(line)
  || /\b(?:following|below)\b.{0,120}\b(?:example|quotation|quoted text|source code)\b/i.test(line);

export const requestEvidenceLines = (
  text: string,
  segments: readonly CapturedSegment[] = [],
): RequestEvidence[] => {
  const result: RequestEvidence[] = [];
  let fence: { marker: string; length: number } | undefined;
  let pendingExample = false;
  let exampleParagraph = false;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (match[0].length === 0) continue;
    const line = match[0].replace(/[\r\n]+$/, "");
    const trimmed = line.trim();
    const start = match.index + (line.length - line.trimStart().length);
    const end = start + trimmed.length;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const wasFenced = fence !== undefined;
    if (delimiter) {
      const marker = delimiter[1]!;
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length && !delimiter[2]?.trim()) fence = undefined;
    }
    const enclosing = segments.find((segment) => segment.type !== "text"
      && Number.isInteger(segment.start) && Number.isInteger(segment.end)
      && segment.start < end && segment.end > start);
    const quoted = /^\s*>/.test(line) || enclosing?.type === "quote";
    const fenced = wasFenced || delimiter !== null || enclosing?.type === "codeBlock" || /^(?: {4}|\t)\S/.test(line);
    const introduced = exampleIntroduction(trimmed);
    if (introduced) pendingExample = true;
    else if (trimmed && pendingExample) {
      exampleParagraph = true;
      pendingExample = false;
    } else if (!trimmed && exampleParagraph) {
      exampleParagraph = false;
    }
    const example = introduced || exampleParagraph;
    if (wasFenced && delimiter && !fence) {
      exampleParagraph = false;
      pendingExample = false;
    }
    result.push({
      start, end, text: trimmed,
      segmentType: quoted ? "quote" : fenced ? "codeBlock" : "text",
      quoted, fenced, example,
      contextBefore: text.slice(Math.max(0, start - 512), start),
      contextAfter: text.slice(end, Math.min(text.length, end + 512)),
      eligible: Boolean(trimmed) && !quoted && !fenced && !example,
    });
  }
  return result;
};

export const isExecutableEvidence = (
  evidence: readonly RequestEvidence[],
  start: number,
  end: number,
): boolean => evidence.some((line) => line.eligible && start >= line.start && end <= line.end);
