import * as path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import type { JsonValue } from "../adapters/types";
import { redactJsonValue, redactText } from "../security/redact";
import { stripExportIdentity, stripUrlLocators } from "./exportIdentity";
import { applyExportPolicy, maskExcludedPaths, type ExportPolicy } from "./exportPolicy";
import {
  createExecutionEvidenceStore, evidenceDigest, evidenceObject, executionEvidenceDirectory,
  EXECUTION_EVIDENCE_LIMITS, parseEvidenceManifest, readPrivateFile, type ExecutionEvidenceRecord,
} from "../state/executionEvidence";

const readExportRecord = async (directory: string, record: ExecutionEvidenceRecord): Promise<string> => {
  const bytes = await readPrivateFile(path.join(directory, record.storage), EXECUTION_EVIDENCE_LIMITS.recordBytes);
  if (bytes.length !== record.byteLength || evidenceDigest(bytes) !== record.digest) throw new Error("Execution export evidence integrity failed");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};
const jsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return evidenceObject(value) && Object.values(value).every(jsonValue);
};
export const exportExecutionEvidence = async (storageDirectory: string, policy?: ExportPolicy): Promise<string> => {
  const root = path.join(storageDirectory, "execution-evidence");
  const entries = await readdir(root).catch((error: unknown) => {
    if (evidenceObject(error) && error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length === 0) throw new Error("This run has no admitted execution evidence");
  if (entries.length > 64 || (await lstat(root)).isSymbolicLink()) throw new Error("Execution evidence export admission refused");
  const scopes = [];
  for (const entry of entries.sort()) {
    if (!/^[a-f0-9]{64}$/.test(entry)) throw new Error("Unexpected execution evidence directory");
    const directory = path.join(root, entry);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe execution evidence directory");
    const value: unknown = JSON.parse((await readPrivateFile(path.join(directory, "manifest.json"), EXECUTION_EVIDENCE_LIMITS.manifestBytes)).toString("utf8"));
    if (!evidenceObject(value) || typeof value.runId !== "string" || typeof value.taskId !== "string") throw new Error("Invalid evidence scope");
    const scope = { runId: value.runId, taskId: value.taskId };
    if (directory !== executionEvidenceDirectory(storageDirectory, scope)) throw new Error("Evidence scope storage mismatch");
    const manifest = parseEvidenceManifest(value, scope);
    scopes.push({ store: createExecutionEvidenceStore(storageDirectory, scope), manifest });
  }
  const locators: string[] = [];
  for (const { store, manifest } of scopes) {
    for (const record of manifest.records.filter((item) => item.kind === "providerLocator")) {
      const value = await readExportRecord(store.directory, record);
      if (value) locators.push(value);
    }
  }
  const sanitized = (content: string): string => {
    let text = redactText(content);
    try {
      const parsed: unknown = JSON.parse(content);
      if (jsonValue(parsed)) {
        const safe = stripExportIdentity(redactJsonValue(parsed));
        text = JSON.stringify(safe) === JSON.stringify(parsed) ? content : JSON.stringify(safe);
      }
    } catch {
      text = redactText(content);
    }
    text = stripUrlLocators(text);
    for (const locator of locators) text = text.split(locator).join("[EXCLUDED]");
    return applyExportPolicy(maskExcludedPaths(text, policy), policy).content;
  };
  const runs = [];
  let bytes = 0;
  for (const { store, manifest } of scopes) {
    const records = [];
    const excluded = [];
    for (const record of manifest.records) {
      if (!record.readers.includes("export") || record.kind === "providerLocator") {
        excluded.push({ id: record.id, reason: "Provider locator or controller-only record excluded." });
        continue;
      }
      const admitted = await readExportRecord(store.directory, record);
      const content = sanitized(admitted);
      const exported = {
        version: record.version, id: record.id, runId: record.runId, taskId: record.taskId,
        kind: record.kind, source: sanitized(record.source), candidate: record.candidate, revision: record.revision,
        admittedDigest: record.digest, admittedByteLength: record.byteLength, completeness: record.completeness,
        exportedDigest: evidenceDigest(content), exportedByteLength: Buffer.byteLength(content, "utf8"),
        exactAdmittedContent: content === admitted,
        redactions: [...record.redactions, ...(content !== admitted ? ["Export credential, provider identity, URL, or repository policy redaction applied; export is not an untouched original."] : [])],
        exclusions: record.exclusions.map(sanitized), content,
      };
      bytes += Buffer.byteLength(JSON.stringify(exported, null, 2), "utf8");
      if (bytes > EXECUTION_EVIDENCE_LIMITS.runBytes) throw new Error("Exact evidence export exceeds 256 MiB; no partial export was produced");
      records.push(exported);
    }
    runs.push({ version: 1, runId: manifest.runId, taskId: manifest.taskId, exclusions: manifest.exclusions.map(sanitized), excluded, records });
  }
  const output = `${JSON.stringify({ version: 1, kind: "bachata.execution-evidence-export", exclusions: ["Provider-private history was never admitted.", "Provider locators and private storage paths are excluded."], runs }, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > EXECUTION_EVIDENCE_LIMITS.runBytes) throw new Error("Execution evidence export admission limit exceeded");
  return output;
};
