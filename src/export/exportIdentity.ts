import type { JsonValue } from "../adapters/types";

const identityKeySuffixes = [
  "sessionid",
  "sessionkey",
  "conversationurl",
  "conversationidentity",
  "conversationid",
  "conversationkey",
  "documenttoken",
  "messagecursor",
  "tabid",
  "frameid",
  "accountid",
  "profileid",
];

const identityJsonKeys = new Set(["session", "conversation", "identity"]);

const normalizeKey = (key: string): string =>
  key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

const isIdentityJsonKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  return identityJsonKeys.has(normalized) ||
    identityKeySuffixes.some((suffix) => normalized.endsWith(suffix));
};

const trailingPunctuation = /[.,;:!?)\]}'"]+$/;

const toOrigin = (candidate: string): string => {
  try {
    const parsed = new URL(candidate);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const hasLocator =
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search !== "" ||
      parsed.hash !== "";
    return hasLocator ? `${origin}/[REDACTED]` : origin;
  } catch {
    return "[REDACTED URL]";
  }
};

export const stripUrlLocators = (value: string): string =>
  value.replace(/https?:\/\/[^\s"'<>`\\]+/gi, (match) => {
    const suffix = trailingPunctuation.exec(match)?.[0] ?? "";
    const candidate = suffix ? match.slice(0, match.length - suffix.length) : match;
    return `${toOrigin(candidate)}${suffix}`;
  });

const stripExportIdentityInternal = (value: JsonValue): JsonValue => {
  if (typeof value === "string") return stripUrlLocators(value);
  if (Array.isArray(value)) return value.map(stripExportIdentityInternal);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isIdentityJsonKey(key) && item !== null
        ? "[EXCLUDED]"
        : stripExportIdentityInternal(item),
    ]),
  );
};

export const stripExportIdentity = (value: JsonValue): JsonValue =>
  stripExportIdentityInternal(value);
