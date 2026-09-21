import type { JsonValue } from "../adapters/types";

const sensitiveJsonKeys = new Set([
  "authorization",
  "proxyauthorization",
  "xapikey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "connectiontoken",
  "token",
  "clientsecret",
  "secret",
  "password",
  "passwd",
  "privatekey",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
]);

export const isSensitiveJsonKey = (key: string): boolean =>
  sensitiveJsonKeys.has(key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase());

const structuredTextKeys = new Set([
  "args",
  "arguments",
  "command",
  "commandline",
  "endpoint",
  "env",
  "environment",
  "headers",
  "stderr",
  "stdout",
  "url",
  "uri",
]);

export const isStructuredTextKey = (key: string): boolean =>
  structuredTextKeys.has(key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase());

type RedactionRule = {
  needles: readonly string[];
  pattern: RegExp;
  replacement: string;
};

const AUTHORIZATION_NEEDLES = ["authorization"] as const;

const SECRET_WORD_NEEDLES = [
  "authorization",
  "api key",
  "api-key",
  "api_key",
  "apikey",
  "access-token",
  "access_token",
  "accesstoken",
  "refresh-token",
  "refresh_token",
  "refreshtoken",
  "client-secret",
  "client_secret",
  "clientsecret",
  "token",
  "secret",
  "password",
  "passwd",
  "private_key",
  "credential",
  "cookie",
] as const;

const assignmentRules: readonly RedactionRule[] = [
  {
    needles: AUTHORIZATION_NEEDLES,
    pattern: /\b(authorization|proxy-authorization)\b(\s*[:=]\s*)(?:Bearer|Basic|Digest)\s+[^\s,;]+/gi,
    replacement: "$1$2[REDACTED]",
  },
  {
    needles: AUTHORIZATION_NEEDLES,
    pattern: /(--?(?:authorization|proxy-authorization))(?:=|\s+)(?:Bearer|Basic|Digest)\s+[^\s,;]+/gi,
    replacement: "$1 [REDACTED]",
  },
  {
    needles: SECRET_WORD_NEEDLES,
    pattern: /(["'](?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|set-cookie)["']\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    replacement: "$1[REDACTED]",
  },
  {
    needles: SECRET_WORD_NEEDLES,
    pattern: /\b(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|set-cookie)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replacement: "$1$2[REDACTED]",
  },
  {
    needles: SECRET_WORD_NEEDLES,
    pattern: /(\b(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIALS?)\b\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
    replacement: "$1[REDACTED]",
  },
  {
    needles: SECRET_WORD_NEEDLES,
    pattern: /(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|client[-_]?secret|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replacement: "$1 [REDACTED]",
  },
  {
    needles: SECRET_WORD_NEEDLES,
    pattern: /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|client[-_]?secret)=)[^&#\s]+/gi,
    replacement: "$1[REDACTED]",
  },
];

const freeFormRules: readonly RedactionRule[] = [
  {
    needles: AUTHORIZATION_NEEDLES,
    pattern: /\b(authorization|proxy-authorization)\b(\s*[:=]\s*)(?:Bearer|Basic|Digest)\s+[^\s,;]+/gi,
    replacement: "$1$2[REDACTED]",
  },
  {
    needles: AUTHORIZATION_NEEDLES,
    pattern: /(--?(?:authorization|proxy-authorization))(?:=|\s+)(?:Bearer|Basic|Digest)\s+[^\s,;]+/gi,
    replacement: "$1 [REDACTED]",
  },
  {
    needles: ["://"],
    pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/[^:\s/@]+:)[^@\s/]+@/gi,
    replacement: "$1[REDACTED]@",
  },
  {
    needles: ["bearer"],
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "Bearer [REDACTED]",
  },
  {
    needles: ["sk-", "rk-", "pk-"],
    pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    needles: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    needles: ["eyj"],
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED]",
  },
];

// A private-key armour block is found by one forward scan, not by a regular expression.
//
// The pattern this replaces matched a fixed label list and a body charset of base64 and
// whitespace. Two whole classes of key therefore survived in full: a label it did not list
// (DSA, ENCRYPTED PRIVATE KEY, PGP PRIVATE KEY BLOCK), and an encrypted PEM of any label,
// whose `Proc-Type:` and `DEK-Info:` headers carry `:` and `,` and so could not be crossed
// by the body charset at all. It also paired any BEGIN label with any END label.
//
// This scan accepts every private-key label, requires the same label at both ends, and
// redacts to the end of the text when a block is never closed, so no body outlives its
// header. Each step is an indexOf over a shrinking suffix and the label test is a single
// bounded character class, so the pass is linear and cannot backtrack.
const PRIVATE_KEY_ARMOR_LABEL_MAX = 64;
const privateKeyArmorLabelCharacters = /^[A-Z0-9 ]+$/;

const isPrivateKeyArmorLabel = (label: string): boolean =>
  label.length > 0
  && label.length <= PRIVATE_KEY_ARMOR_LABEL_MAX
  && (label === "PRIVATE KEY"
    || label.endsWith(" PRIVATE KEY")
    || label === "PGP PRIVATE KEY BLOCK")
  && privateKeyArmorLabelCharacters.test(label);

const PRIVATE_KEY_ARMOR_BEGIN = "-----BEGIN ";
const PRIVATE_KEY_ARMOR_FENCE = "-----";

export const redactPrivateKeyArmor = (value: string): string => {
  if (!value.includes(PRIVATE_KEY_ARMOR_BEGIN)) return value;
  // Two cursors, because they answer different questions: `copiedTo` is how much of the
  // input has been emitted, and `scanFrom` is where the next header search starts. A
  // `-----BEGIN CERTIFICATE-----` advances only the scan; moving the copy cursor with it
  // would drop the armour line of every block this function is not meant to touch.
  let copiedTo = 0;
  let scanFrom = 0;
  let output = "";
  for (;;) {
    const begin = value.indexOf(PRIVATE_KEY_ARMOR_BEGIN, scanFrom);
    if (begin < 0) break;
    const labelStart = begin + PRIVATE_KEY_ARMOR_BEGIN.length;
    const labelEnd = value.indexOf(PRIVATE_KEY_ARMOR_FENCE, labelStart);
    if (labelEnd < 0) break;
    const label = value.slice(labelStart, labelEnd);
    if (!isPrivateKeyArmorLabel(label)) {
      scanFrom = labelStart;
      continue;
    }
    output += value.slice(copiedTo, begin) + "[REDACTED PRIVATE KEY]";
    const endMarker = `-----END ${label}-----`;
    const end = value.indexOf(endMarker, labelEnd);
    if (end < 0) {
      // Nothing after an unterminated header may be treated as safe.
      return output;
    }
    copiedTo = end + endMarker.length;
    scanFrom = copiedTo;
  }
  return output + value.slice(copiedTo);
};

const applyRules = (value: string, rules: readonly RedactionRule[]): string => {
  let current = value;
  let lowered = value.toLowerCase();
  for (const rule of rules) {
    if (!rule.needles.some((needle) => lowered.includes(needle))) continue;
    const next = current.replace(rule.pattern, rule.replacement);
    if (next !== current) {
      current = next;
      lowered = next.toLowerCase();
    }
  }
  return current;
};

export const redactFreeFormText = (value: string): string =>
  applyRules(redactPrivateKeyArmor(value), freeFormRules);

export const redactText = (value: string): string =>
  applyRules(redactFreeFormText(value), assignmentRules);

const redactJsonValueInternal = (
  value: JsonValue,
  parentKey?: string,
): JsonValue => {
  if (typeof value === "string") {
    return parentKey && isStructuredTextKey(parentKey)
      ? redactText(value)
      : redactFreeFormText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValueInternal(item, parentKey));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveJsonKey(key)
        ? "[REDACTED]"
        : redactJsonValueInternal(item, key),
    ]),
  );
};

export const redactJsonValue = (value: JsonValue): JsonValue =>
  redactJsonValueInternal(value);

/**
 * How far back from a bounded prefix's end a secret may begin.
 *
 * A projection that only ever looks at a fixed prefix of a provider string cannot see whether a
 * credential that starts near the end of that prefix continues past it. Redaction rules terminate
 * their value match at the end of the input, so an unterminated quoted secret or an armour block
 * whose fence falls past the cut can survive in part. The answer is not to look further — that is
 * the unbounded scan the prefix exists to refuse — but to stop emitting earlier: nothing from the
 * point where a secret construct may have begun travels at all.
 *
 * This window is the longest run of characters that may be discarded for that reason.
 */
export const SECRET_BOUNDARY_WINDOW = 256;

/**
 * Lowercase markers that a secret construct may begin here. Deliberately broader than the
 * redaction rules: a quote or a dash run costs at most this window's characters of a string that
 * is being truncated anyway, and being wrong in the other direction emits half a credential.
 */
const boundaryIndicators: readonly string[] = [
  ...SECRET_WORD_NEEDLES,
  "bearer",
  "://",
  "sk-",
  "rk-",
  "pk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "eyj",
  "-----",
  "\"",
  "'",
];

const HYPHEN = 0x2d;

/**
 * Where a prefix of `head` may safely end when the source continues past it.
 *
 * Returns the index of the earliest point within the last `SECRET_BOUNDARY_WINDOW` characters at
 * which a secret construct may begin — counting a marker the prefix only starts, such as a string
 * ending in `passwo` or in a partial armour fence. When nothing in the window suggests one,
 * `head.length` is returned and the whole prefix travels.
 *
 * The scan is over a fixed-size window, so its cost does not depend on the source's length.
 */
export const secretBoundaryCut = (head: string): number => {
  const from = head.length <= SECRET_BOUNDARY_WINDOW ? 0 : head.length - SECRET_BOUNDARY_WINDOW;
  const tail = head.slice(from).toLowerCase();
  let cut = tail.length;
  for (const indicator of boundaryIndicators) {
    const found = tail.indexOf(indicator);
    if (found >= 0 && found < cut) cut = found;
    for (let length = indicator.length - 1; length > 0; length -= 1) {
      const start = tail.length - length;
      if (start >= cut) continue;
      if (tail.endsWith(indicator.slice(0, length))) {
        cut = start;
        break;
      }
    }
  }
  let dashes = tail.length;
  while (dashes > 0 && tail.charCodeAt(dashes - 1) === HYPHEN) dashes -= 1;
  if (dashes < cut) cut = dashes;
  return from + cut;
};
