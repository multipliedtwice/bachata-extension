import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import * as path from "node:path";
import { redactText } from "../security/redact";

export const EXECUTION_EVIDENCE_LIMITS = {
  recordBytes: 16 * 1024 * 1024,
  runBytes: 256 * 1024 * 1024,
  records: 4096,
  pageBytes: 16 * 1024,
  manifestBytes: 8 * 1024 * 1024,
} as const;

export type EvidenceScope = { runId: string; taskId: string };
export type EvidenceKind = "prompt" | "answer" | "controller" | "task" | "bundle" | "baseline" | "changedPaths" | "providerLocator";
export type EvidenceReader = "controller" | "planner" | "worker" | "reviewer" | "export";
export type ExecutionEvidenceRecord = EvidenceScope & {
  version: 1;
  id: string;
  kind: EvidenceKind;
  source: string;
  digest: string;
  byteLength: number;
  completeness: "complete";
  candidate: string | null;
  revision: number | null;
  readers: EvidenceReader[];
  storage: string;
  redactions: string[];
  exclusions: string[];
};
export type EvidenceManifest = EvidenceScope & {
  version: 1;
  records: ExecutionEvidenceRecord[];
  exclusions: string[];
};
export type EvidencePage = {
  id: string;
  digest: string;
  start: number;
  end: number;
  totalBytes: number;
  text: string;
  nextStart: number | null;
  historical: boolean;
};
export const evidenceDigest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const idPattern = /^[a-f0-9-]{36}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const kinds: readonly string[] = ["prompt", "answer", "controller", "task", "bundle", "baseline", "changedPaths", "providerLocator"];
const readers: readonly string[] = ["controller", "planner", "worker", "reviewer", "export"];
export const evidenceObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], required = allowed): boolean =>
  Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, max = 1024): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max;
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 16 && value.every((item) => text(item));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const recordKeys = ["version", "runId", "taskId", "id", "kind", "source", "digest", "byteLength", "completeness", "candidate", "revision", "readers", "storage", "redactions", "exclusions"];
const isRecord = (value: unknown): value is ExecutionEvidenceRecord => {
  if (!evidenceObject(value) || !exactKeys(value, recordKeys)) return false;
  return value.version === 1 && text(value.runId) && text(value.taskId)
    && typeof value.id === "string" && idPattern.test(value.id)
    && typeof value.kind === "string" && kinds.includes(value.kind) && text(value.source)
    && typeof value.digest === "string" && digestPattern.test(value.digest)
    && integer(value.byteLength) && value.byteLength <= EXECUTION_EVIDENCE_LIMITS.recordBytes
    && value.completeness === "complete"
    && (value.candidate === null || text(value.candidate))
    && (value.revision === null || integer(value.revision))
    && Array.isArray(value.readers) && value.readers.length > 0 && value.readers.length <= readers.length
    && new Set(value.readers).size === value.readers.length
    && value.readers.every((item) => typeof item === "string" && readers.includes(item))
    && value.storage === `${value.id}.utf8` && texts(value.redactions) && texts(value.exclusions)
    && (value.kind !== "providerLocator" || value.readers.every((reader) => reader === "controller"));
};
export const parseEvidenceManifest = (value: unknown, scope: EvidenceScope): EvidenceManifest => {
  if (!evidenceObject(value) || !exactKeys(value, ["version", "runId", "taskId", "records", "exclusions"])
    || value.version !== 1 || value.runId !== scope.runId || value.taskId !== scope.taskId
    || !texts(value.exclusions) || !Array.isArray(value.records)
    || value.records.length > EXECUTION_EVIDENCE_LIMITS.records || !value.records.every(isRecord)) {
    throw new Error("Invalid execution evidence manifest");
  }
  const records = value.records;
  if (new Set(records.map((record) => record.id)).size !== records.length
    || records.some((record) => record.runId !== scope.runId || record.taskId !== scope.taskId)
    || records.reduce((sum, record) => sum + record.byteLength, 0) > EXECUTION_EVIDENCE_LIMITS.runBytes) {
    throw new Error("Execution evidence manifest scope or admission limit failed");
  }
  return { version: 1, ...scope, records, exclusions: value.exclusions };
};
export const readPrivateFile = async (file: string, maxBytes: number): Promise<Buffer> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Private execution file is not an admitted regular file");
    const buffer = await handle.readFile();
    if (buffer.byteLength > maxBytes) throw new Error("Private execution file grew beyond its admission limit");
    return buffer;
  } finally {
    await handle.close();
  }
};
export const writePrivateFile = async (file: string, content: string, immutable = false): Promise<void> => {
  const target = immutable ? file : `${file}.${randomUUID()}.pending`;
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!immutable) await rename(target, file);
  if (process.platform !== "win32") {
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
};
export const executionEvidenceDirectory = (storageDirectory: string, scope: EvidenceScope): string =>
  path.join(storageDirectory, "execution-evidence", evidenceDigest(JSON.stringify({ runId: scope.runId, taskId: scope.taskId })));
const notFound = (error: unknown): boolean => evidenceObject(error) && error.code === "ENOENT";
export type EvidenceStoreOptions = {
  onRecord?: (record: ExecutionEvidenceRecord) => Promise<void> | void;
  withMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
};
export const createExecutionEvidenceStore = (storageDirectory: string, inputScope: EvidenceScope, options: EvidenceStoreOptions = {}) => {
  const scope = { runId: inputScope.runId, taskId: inputScope.taskId };
  if (!text(scope.runId) || !text(scope.taskId)) throw new Error("Invalid evidence scope");
  const mutate = options.withMutation ?? (<T>(operation: () => Promise<T>): Promise<T> => operation());
  const directory = executionEvidenceDirectory(storageDirectory, scope);
  const manifestPath = path.join(directory, "manifest.json");
  let tail: Promise<void> = Promise.resolve();
  const prepare = async (): Promise<void> => {
    const parent = path.dirname(directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Unsafe evidence directory");
    const directories = await readdir(parent);
    if (!directories.includes(path.basename(directory)) && directories.length >= 64) throw new Error("Execution evidence task retention limit reached");
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!evidenceObject(error) || error.code !== "EEXIST") throw error;
    });
    for (const root of [parent, directory]) {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe evidence directory");
    }
  };
  const readManifest = async (): Promise<EvidenceManifest> => {
    try {
      for (const root of [path.dirname(directory), directory]) {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe evidence directory");
      }
      return parseEvidenceManifest(JSON.parse((await readPrivateFile(manifestPath, EXECUTION_EVIDENCE_LIMITS.manifestBytes)).toString("utf8")), scope);
    } catch (error) {
      if (!notFound(error)) throw error;
      return { version: 1, ...scope, records: [], exclusions: ["Provider-private internal history is not exposed by adapters and is not archived."] };
    }
  };
  const manifest = readManifest;
  const put = (input: {
    kind: EvidenceKind;
    source: string;
    content: string;
    candidate?: string;
    revision?: number;
    readers?: EvidenceReader[];
    redactions?: string[];
    exclusions?: string[];
  }): Promise<ExecutionEvidenceRecord> => {
    const operation = tail.then(() => mutate(async () => {
      if (Buffer.byteLength(input.content, "utf8") > EXECUTION_EVIDENCE_LIMITS.recordBytes) throw new Error("Exact evidence admission refused: record too large");
      if (Buffer.from(input.content, "utf8").toString("utf8") !== input.content) throw new Error("Evidence contains invalid Unicode");
      const content = redactText(input.content);
      const bytes = Buffer.byteLength(content, "utf8");
      await prepare();
      const current = await readManifest();
      const files = await readdir(directory);
      if (files.length >= EXECUTION_EVIDENCE_LIMITS.records * 2 + 2) throw new Error("Evidence file admission limit reached");
      let storedBytes = 0;
      for (const file of files) {
        const info = await lstat(path.join(directory, file));
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unexpected evidence storage entry");
        storedBytes += info.size;
      }
      if (current.records.length >= EXECUTION_EVIDENCE_LIMITS.records || storedBytes + bytes > EXECUTION_EVIDENCE_LIMITS.runBytes) throw new Error("Exact evidence admission refused: run storage limit");
      const id = randomUUID();
      const record: ExecutionEvidenceRecord = {
        version: 1, ...scope, id, kind: input.kind, source: input.source,
        digest: evidenceDigest(content), byteLength: bytes, completeness: "complete",
        candidate: input.candidate ?? null, revision: input.revision ?? null,
        readers: input.kind === "providerLocator" ? ["controller"] : input.readers ?? ["controller", "planner", "worker", "reviewer", "export"],
        storage: `${id}.utf8`,
        redactions: [...(input.redactions ?? []), ...(content === input.content ? [] : ["Existing credential redaction applied before admission."])],
        exclusions: input.exclusions ?? [],
      };
      if (!isRecord(record)) throw new Error("Invalid evidence admission metadata");
      const next = JSON.stringify({ ...current, records: [...current.records, record] });
      if (Buffer.byteLength(next, "utf8") > EXECUTION_EVIDENCE_LIMITS.manifestBytes) throw new Error("Evidence manifest admission limit reached");
      if (storedBytes + bytes + Buffer.byteLength(next, "utf8") + 256 * 1024 > EXECUTION_EVIDENCE_LIMITS.runBytes) throw new Error("Exact evidence admission refused: run storage limit");
      await writePrivateFile(path.join(directory, record.storage), content, true);
      await writePrivateFile(manifestPath, next);
      await options.onRecord?.(record);
      return record;
    }));
    tail = operation.then(() => undefined);
    void tail.catch(() => undefined);
    return operation;
  };
  const read = async (id: string, reader: EvidenceReader): Promise<{ record: ExecutionEvidenceRecord; content: string }> => {
    const record = (await manifest()).records.find((entry) => entry.id === id);
    if (!record || !record.readers.includes(reader) || record.completeness !== "complete") throw new Error("Evidence reference is unavailable or unauthorized");
    const bytes = await readPrivateFile(path.join(directory, record.storage), EXECUTION_EVIDENCE_LIMITS.recordBytes);
    if (bytes.length !== record.byteLength || evidenceDigest(bytes) !== record.digest) throw new Error("Evidence integrity check failed");
    return { record, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  };
  const page = async (input: {
    id: string; reader: EvidenceReader; start: number; end: number; candidate: string; use: "history" | "current";
  }): Promise<EvidencePage> => {
    if (!integer(input.start) || !integer(input.end) || input.end <= input.start || input.end - input.start > EXECUTION_EVIDENCE_LIMITS.pageBytes) throw new Error("Invalid evidence page bounds");
    const { record, content } = await read(input.id, input.reader);
    const historical = record.candidate !== null && record.candidate !== input.candidate;
    if (input.use === "current" && historical) throw new Error("Historical evidence cannot authorize current work");
    const bytes = Buffer.from(content, "utf8");
    if (input.end > bytes.length) throw new Error("Evidence page exceeds admitted content");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(input.start, input.end));
    return { id: record.id, digest: record.digest, start: input.start, end: input.end, totalBytes: bytes.length, text: decoded, nextStart: input.end < bytes.length ? input.end : null, historical };
  };
  return { manifest, put, read, page, directory };
};
export type ExecutionEvidenceStore = ReturnType<typeof createExecutionEvidenceStore>;
export type ControllerEvidenceCapture = (source: string, content: string) => Promise<void>;
const controllerCapture = new AsyncLocalStorage<ControllerEvidenceCapture>();
export const withControllerEvidence = <T>(capture: ControllerEvidenceCapture, operation: () => Promise<T>): Promise<T> => controllerCapture.run(capture, operation);
export const currentControllerEvidenceCapture = (): ControllerEvidenceCapture | undefined => controllerCapture.getStore();
