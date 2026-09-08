import { randomBytes } from "node:crypto";

const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const referenceLength = 8;
const referencePattern = /^[RIPCSQANYTDFX][2-9A-HJ-NP-Z]{8}$/u;
const runTitlePattern = /^\[(R[2-9A-HJ-NP-Z]{8})\]\s+(.+)$/u;
const providerTitlePattern = /^\[bachata:(R[2-9A-HJ-NP-Z]{8}):(C[2-9A-HJ-NP-Z]{8})\]\s+(.+)$/u;

export type ReferencePrefix =
  | "R" | "I" | "P" | "C" | "S" | "Q" | "A"
  | "N" | "Y" | "T" | "D" | "F" | "X";

export const createReference = (
  prefix: ReferencePrefix,
  bytes: (size: number) => Buffer = randomBytes,
): string => {
  let value = prefix;
  while (value.length <= referenceLength) {
    const chunk = bytes(referenceLength);
    for (const byte of chunk) {
      value += alphabet[byte & 31];
      if (value.length > referenceLength) {
        break;
      }
    }
  }
  return value;
};

export const isReference = (
  value: string,
  prefix?: ReferencePrefix,
): boolean => referencePattern.test(value) && (prefix === undefined || value.startsWith(prefix));

export const parseRunTitle = (
  value: string,
): { runRef: string; title: string } | undefined => {
  const [, runRef, title] = value.match(runTitlePattern) ?? [];
  return runRef === undefined || title === undefined ? undefined : { runRef, title };
};

export const formatRunTitle = (runRef: string, title: string): string => {
  const readable = parseRunTitle(title)?.title ?? title;
  return `[${runRef}] ${readable.trim() || "New run"}`;
};

export const formatProviderChatTitle = (
  runRef: string,
  chatRef: string,
  role: string,
  title: string,
): string => `[bachata:${runRef}:${chatRef}] ${role.trim()} · ${title.trim()}`;

export const parseProviderChatTitle = (
  value: string,
): { runRef: string; chatRef: string; title: string } | undefined => {
  const [, runRef, chatRef, title] = value.match(providerTitlePattern) ?? [];
  if (runRef === undefined || chatRef === undefined || title === undefined) {
    return undefined;
  }
  return { runRef, chatRef, title };
};
