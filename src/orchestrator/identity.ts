import { createHash } from "node:crypto";

export const legacyStorageIdentity = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "task";

const readablePart = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "item";

export const taskStorageIdentity = (value: string): string =>
  `${readablePart(value)}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
