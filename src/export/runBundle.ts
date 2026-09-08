import { createHash } from "node:crypto";

import { redactJsonValue } from "../security/redact";
import { stripExportIdentity } from "./exportIdentity";
import type { JsonValue } from "../adapters/types";

export type RunBundleIntegrity = {
  algorithm: "sha256";
  value: string;
};

export type RunBundle = {
  version: 1;
  exportedAt: string;
  integrity: RunBundleIntegrity;
  run: JsonValue;
};

export const runBundleDigest = (
  input: { version: 1; exportedAt: string; run: JsonValue },
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({ version: input.version, exportedAt: input.exportedAt, run: input.run }),
      "utf8",
    )
    .digest("hex");

const toJsonValue = (value: unknown): JsonValue => {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
};

const stable = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
};

export const createRunBundle = (
  run: unknown,
  exportedAt: string,
  maxBytes = 2_097_152,
): string => {
  const section = stable(stripExportIdentity(redactJsonValue(toJsonValue(run))));
  const bundle: RunBundle = {
    version: 1,
    exportedAt,
    integrity: {
      algorithm: "sha256",
      value: runBundleDigest({ version: 1, exportedAt, run: section }),
    },
    run: section,
  };
  const serialized = `${JSON.stringify(bundle, undefined, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`Run bundle exceeds ${String(maxBytes)} bytes`);
  }
  return serialized;
};
