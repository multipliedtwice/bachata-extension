import type { CapturedResponse } from "./protocol";

export type BrowserControlStatus =
  | "needContext"
  | "applyPatch"
  | "verify"
  | "reviewComplete"
  | "done"
  | "blocked";

export type BrowserContextReadAction = {
  kind: "context.read";
  snippetIds: string[];
};

export type BrowserContextReadTaskAction = {
  kind: "context.readTask";
  offsetBytes?: number;
  maxBytes?: number;
};

export type BrowserContextMetadataField =
  | "constraints"
  | "readPaths"
  | "allowedPaths"
  | "requiredVerificationCheckIds"
  | "changedFiles"
  | "preexistingChangedFiles"
  | "policyViolations"
  | "verification"
  | "unresolved";

export type BrowserContextReadMetadataAction = {
  kind: "context.readMetadata";
  field: BrowserContextMetadataField;
  offset?: number;
  limit?: number;
};

export type BrowserContextListAction = {
  kind: "context.list";
  path: string;
  cursor?: string;
  limit?: number;
};

export type BrowserContextTreeAction = {
  kind: "context.tree";
  path: string;
  depth?: number;
  cursor?: string;
  limit?: number;
};

export type BrowserContextReadFileAction = {
  kind: "context.readFile";
  path: string;
  startLine?: number;
  endLine?: number;
};

export type BrowserContextSearchAction = {
  kind: "context.search";
  query: string;
  pathPrefix?: string;
  cursor?: string;
};

export type BrowserContextHashFileAction = {
  kind: "context.hashFile";
  path: string;
};

export type BrowserContextDependenciesAction = {
  kind: "context.dependencies";
  path: string;
};

export type BrowserContextDependentsAction = {
  kind: "context.dependents";
  path: string;
  cursor?: string;
};

export type BrowserWriteAction = {
  kind: "workspace.write";
  path: string;
  content: string;
  expectedFiles: Array<{ path: string; sha256: string }>;
};

export type BrowserDeleteAction = {
  kind: "workspace.delete";
  path: string;
  expectedFiles: Array<{ path: string; sha256: string }>;
};

export type BrowserApplyPatchAction = {
  kind: "workspace.applyPatch";
  patch: string;
  expectedFiles: Array<{ path: string; sha256: string }>;
};

export type BrowserVerificationAction = {
  kind: "verification.run";
  checkIds: string[];
};

export type BrowserControlAction =
  | BrowserContextReadAction
  | BrowserContextReadTaskAction
  | BrowserContextReadMetadataAction
  | BrowserContextListAction
  | BrowserContextTreeAction
  | BrowserContextReadFileAction
  | BrowserContextSearchAction
  | BrowserContextHashFileAction
  | BrowserContextDependenciesAction
  | BrowserContextDependentsAction
  | BrowserWriteAction
  | BrowserDeleteAction
  | BrowserApplyPatchAction
  | BrowserVerificationAction;

export type BrowserControlEnvelope = {
  protocol: "bachata-browser-turn-v1";
  status: BrowserControlStatus;
  actions: BrowserControlAction[];
  summary: string;
  objections: string[];
  unresolved: string[];
};

export type BrowserActionEvidence = {
  actionIndex: number;
  kind: string;
  ok: boolean;
  summary: string;
  output?: string;
};

export type BrowserTurnResult = {
  naturalAnswer: string;
  control?: BrowserControlEnvelope;
  evidence: BrowserActionEvidence[];
  assets: unknown[];
};

export type LeadDecision = {
  protocol: "bachata-lead-review-v1";
  decision: "accept" | "revise" | "blocked";
  objections: Array<{
    id: string;
    path?: string;
    symbol?: string;
    evidence: string;
    requiredChange: string;
  }>;
  unresolvedRisks: string[];
};

const MAX_ACTIONS = 16;
const MAX_TEXT = 262_144;
const SHA256 = /^[a-f0-9]{64}$/i;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const exactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).every((key) => keys.includes(key));

const strings = (value: unknown, max = 64): string[] | undefined => {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  const normalized = value.map((entry) => entry.trim());
  return normalized.every((entry) => entry.length <= MAX_TEXT) ? normalized : undefined;
};

const parseAction = (value: unknown): BrowserControlAction | undefined => {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string") {
    return undefined;
  }
  if (record.kind === "context.read") {
    if (!exactKeys(record, ["kind", "snippetIds"])) {
      return undefined;
    }
    const snippetIds = strings(record.snippetIds, 16);
    return snippetIds && snippetIds.length > 0 && snippetIds.every(Boolean)
      ? { kind: "context.read", snippetIds }
      : undefined;
  }
  if (record.kind === "context.readTask") {
    if (!exactKeys(record, ["kind", "offsetBytes", "maxBytes"])
      || (record.offsetBytes !== undefined
        && (!Number.isSafeInteger(record.offsetBytes) || Number(record.offsetBytes) < 0))
      || (record.maxBytes !== undefined
        && (!Number.isSafeInteger(record.maxBytes) || Number(record.maxBytes) < 1 || Number(record.maxBytes) > 16_384))) {
      return undefined;
    }
    return {
      kind: "context.readTask",
      ...(typeof record.offsetBytes === "number" ? { offsetBytes: record.offsetBytes } : {}),
      ...(typeof record.maxBytes === "number" ? { maxBytes: record.maxBytes } : {}),
    };
  }
  if (record.kind === "context.readMetadata") {
    const fields = new Set<BrowserContextMetadataField>([
      "constraints",
      "readPaths",
      "allowedPaths",
      "requiredVerificationCheckIds",
      "changedFiles",
      "preexistingChangedFiles",
      "policyViolations",
      "verification",
      "unresolved",
    ]);
    if (!exactKeys(record, ["kind", "field", "offset", "limit"])
      || typeof record.field !== "string"
      || !fields.has(record.field as BrowserContextMetadataField)
      || (record.offset !== undefined
        && (!Number.isSafeInteger(record.offset) || Number(record.offset) < 0))
      || (record.limit !== undefined
        && (!Number.isSafeInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > 128))) {
      return undefined;
    }
    return {
      kind: "context.readMetadata",
      field: record.field as BrowserContextMetadataField,
      ...(typeof record.offset === "number" ? { offset: record.offset } : {}),
      ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    };
  }
  if (record.kind === "context.list") {
    if (!exactKeys(record, ["kind", "path", "cursor", "limit"])
      || typeof record.path !== "string"
      || record.path.trim().length === 0
      || record.path.length > 16_384
      || (record.cursor !== undefined && (typeof record.cursor !== "string" || record.cursor.length > 256))
      || (record.limit !== undefined
        && (!Number.isSafeInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > 512))) {
      return undefined;
    }
    return {
      kind: "context.list",
      path: record.path,
      ...(typeof record.cursor === "string" ? { cursor: record.cursor } : {}),
      ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    };
  }
  if (record.kind === "context.tree") {
    if (!exactKeys(record, ["kind", "path", "depth", "cursor", "limit"])
      || typeof record.path !== "string"
      || record.path.trim().length === 0
      || record.path.length > 16_384
      || (record.depth !== undefined
        && (!Number.isSafeInteger(record.depth) || Number(record.depth) < 1 || Number(record.depth) > 8))
      || (record.cursor !== undefined && (typeof record.cursor !== "string" || record.cursor.length > 256))
      || (record.limit !== undefined
        && (!Number.isSafeInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > 512))) {
      return undefined;
    }
    return {
      kind: "context.tree",
      path: record.path,
      ...(typeof record.depth === "number" ? { depth: record.depth } : {}),
      ...(typeof record.cursor === "string" ? { cursor: record.cursor } : {}),
      ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    };
  }
  if (record.kind === "context.readFile") {
    if (!exactKeys(record, ["kind", "path", "startLine", "endLine"])
      || typeof record.path !== "string"
      || record.path.trim().length === 0
      || record.path.length > 16_384
      || (record.startLine !== undefined
        && (!Number.isSafeInteger(record.startLine) || Number(record.startLine) < 1))
      || (record.endLine !== undefined
        && (!Number.isSafeInteger(record.endLine) || Number(record.endLine) < 1))
      || (typeof record.startLine === "number"
        && typeof record.endLine === "number"
        && record.endLine < record.startLine)) {
      return undefined;
    }
    return {
      kind: "context.readFile",
      path: record.path,
      ...(typeof record.startLine === "number" ? { startLine: record.startLine } : {}),
      ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
    };
  }
  if (record.kind === "context.search") {
    if (!exactKeys(record, ["kind", "query", "pathPrefix", "cursor"])
      || typeof record.query !== "string"
      || record.query.trim().length === 0
      || record.query.length > 16_384
      || (record.pathPrefix !== undefined
        && (typeof record.pathPrefix !== "string" || record.pathPrefix.length > 16_384))
      || (record.cursor !== undefined && (typeof record.cursor !== "string" || record.cursor.length > 256))) {
      return undefined;
    }
    return {
      kind: "context.search",
      query: record.query,
      ...(typeof record.pathPrefix === "string" ? { pathPrefix: record.pathPrefix } : {}),
      ...(typeof record.cursor === "string" ? { cursor: record.cursor } : {}),
    };
  }
  if (record.kind === "context.hashFile") {
    if (!exactKeys(record, ["kind", "path"])
      || typeof record.path !== "string"
      || record.path.trim().length === 0
      || record.path.length > 16_384) {
      return undefined;
    }
    return { kind: "context.hashFile", path: record.path };
  }
  if (record.kind === "context.dependencies") {
    if (!exactKeys(record, ["kind", "path"])
      || typeof record.path !== "string"
      || record.path.trim().length === 0
      || record.path.length > 16_384) {
      return undefined;
    }
    return { kind: "context.dependencies", path: record.path };
  }
  if (record.kind === "context.dependents") {
    if (!exactKeys(record, ["kind", "path", "cursor"])
      || typeof record.path !== "string"
      || record.path.trim().length === 0
      || record.path.length > 16_384
      || (record.cursor !== undefined && (typeof record.cursor !== "string" || record.cursor.length > 256))) {
      return undefined;
    }
    return {
      kind: "context.dependents",
      path: record.path,
      ...(typeof record.cursor === "string" ? { cursor: record.cursor } : {}),
    };
  }
  if (record.kind === "workspace.write") {
    if (!exactKeys(record, ["kind", "path", "content", "expectedFiles"])
      || typeof record.path !== "string"
      || record.path.trim().length === 0
      || record.path.length > 16_384
      || typeof record.content !== "string"
      || record.content.length > MAX_TEXT
      || !Array.isArray(record.expectedFiles)
      || record.expectedFiles.length > 1) {
      return undefined;
    }
    const expectedFiles: Array<{ path: string; sha256: string }> = [];
    for (const entry of record.expectedFiles) {
      const expected = asRecord(entry);
      if (!expected || !exactKeys(expected, ["path", "sha256"])
        || typeof expected.path !== "string" || expected.path !== record.path
        || typeof expected.sha256 !== "string" || !SHA256.test(expected.sha256)) {
        return undefined;
      }
      expectedFiles.push({ path: expected.path, sha256: expected.sha256.toLowerCase() });
    }
    return { kind: "workspace.write", path: record.path, content: record.content, expectedFiles };
  }
  if (record.kind === "workspace.delete") {
    if (!exactKeys(record, ["kind", "path", "expectedFiles"])
      || typeof record.path !== "string"
      || record.path.trim().length === 0
      || record.path.length > 16_384
      || !Array.isArray(record.expectedFiles)
      || record.expectedFiles.length !== 1) {
      return undefined;
    }
    const expected = asRecord(record.expectedFiles[0]);
    if (!expected || !exactKeys(expected, ["path", "sha256"])
      || typeof expected.path !== "string" || expected.path !== record.path
      || typeof expected.sha256 !== "string" || !SHA256.test(expected.sha256)) {
      return undefined;
    }
    return { kind: "workspace.delete", path: record.path, expectedFiles: [{ path: expected.path, sha256: expected.sha256.toLowerCase() }] };
  }
  if (record.kind === "workspace.applyPatch") {
    if (!exactKeys(record, ["kind", "patch", "expectedFiles"])
      || typeof record.patch !== "string"
      || record.patch.length > MAX_TEXT
      || !Array.isArray(record.expectedFiles)
      || record.expectedFiles.length > 64) {
      return undefined;
    }
    const expectedFiles: Array<{ path: string; sha256: string }> = [];
    for (const entry of record.expectedFiles) {
      const expected = asRecord(entry);
      if (!expected
        || !exactKeys(expected, ["path", "sha256"])
        || typeof expected.path !== "string"
        || typeof expected.sha256 !== "string"
        || !SHA256.test(expected.sha256)) {
        return undefined;
      }
      expectedFiles.push({ path: expected.path, sha256: expected.sha256.toLowerCase() });
    }
    return { kind: "workspace.applyPatch", patch: record.patch, expectedFiles };
  }
  if (record.kind === "verification.run") {
    if (!exactKeys(record, ["kind", "checkIds"])) {
      return undefined;
    }
    const checkIds = strings(record.checkIds);
    return checkIds && checkIds.length > 0 && checkIds.every(Boolean) && new Set(checkIds).size === checkIds.length
      ? { kind: "verification.run", checkIds }
      : undefined;
  }
  return undefined;
};

export const validateBrowserControlEnvelope = (value: unknown): BrowserControlEnvelope | undefined => {
  const record = asRecord(value);
  if (!record
    || !exactKeys(record, ["protocol", "status", "actions", "summary", "objections", "unresolved"])
    || record.protocol !== "bachata-browser-turn-v1"
    || !["needContext", "applyPatch", "verify", "reviewComplete", "done", "blocked"].includes(String(record.status))
    || !Array.isArray(record.actions)
    || record.actions.length > MAX_ACTIONS
    || typeof record.summary !== "string"
    || record.summary.length > 65_536) {
    return undefined;
  }
  const objections = strings(record.objections);
  const unresolved = strings(record.unresolved);
  if (!objections || !unresolved) {
    return undefined;
  }
  const actions: BrowserControlAction[] = [];
  for (const action of record.actions) {
    const parsed = parseAction(action);
    if (!parsed) {
      return undefined;
    }
    actions.push(parsed);
  }
  const status = record.status as BrowserControlStatus;
  const contextActions = actions.filter((action) =>
    action.kind === "context.read"
    || action.kind === "context.readTask"
    || action.kind === "context.readMetadata"
    || action.kind === "context.list"
    || action.kind === "context.tree"
    || action.kind === "context.readFile"
    || action.kind === "context.search"
    || action.kind === "context.hashFile"
    || action.kind === "context.dependencies"
    || action.kind === "context.dependents"
  );
  const patchActions = actions.filter((action) => action.kind === "workspace.applyPatch" || action.kind === "workspace.write" || action.kind === "workspace.delete");
  const verificationActions = actions.filter((action) => action.kind === "verification.run");
  if (status === "needContext" && (actions.length === 0 || contextActions.length !== actions.length)) {
    return undefined;
  }
  if (status === "applyPatch" && (actions.length !== 1 || patchActions.length !== 1)) {
    return undefined;
  }
  if (status === "verify" && (actions.length !== 1 || verificationActions.length !== 1)) {
    return undefined;
  }
  if (["blocked", "reviewComplete", "done"].includes(status) && actions.length !== 0) {
    return undefined;
  }
  return {
    protocol: "bachata-browser-turn-v1",
    status,
    actions,
    summary: record.summary,
    objections,
    unresolved,
  };
};

const fencedBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  const pattern = /```(?:bachata-control|bachata_control|bachata-browser-turn|json)?\s*\n?([\s\S]*?)```/gi;
  for (const match of text.matchAll(pattern)) {
    blocks.push((match[1] ?? "").trim());
  }
  return blocks;
};

const finalPairControlBlock = (text: string): string | undefined => {
  const pattern = /```bachata-control[ \t]*\r?\n([\s\S]*?)```/gi;
  for (const match of Array.from(text.matchAll(pattern)).reverse()) {
    const end = (match.index ?? 0) + match[0].length;
    if (text.slice(end).trim().length === 0) return (match[1] ?? "").trim();
  }
  return undefined;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const extractBrowserControlEnvelope = (text: string): BrowserControlEnvelope | undefined => {
  const candidate = finalPairControlBlock(text);
  return candidate === undefined
    ? undefined
    : validateBrowserControlEnvelope(parseJson(candidate));
};

const normalizedControlLanguage = (value: string | undefined): string =>
  (value ?? "").trim().toLowerCase().replace(/_/g, "-");

export const extractBrowserControlEnvelopeFromCaptured = (
  response: Pick<CapturedResponse, "text" | "segments">,
): BrowserControlEnvelope | undefined => {
  const meaningful = response.segments.filter((segment) => segment.text.trim().length > 0);
  const finalSegment = meaningful.at(-1);
  if (finalSegment?.type === "codeBlock"
    && normalizedControlLanguage(finalSegment.language) === "bachata-control") {
    const parsed = validateBrowserControlEnvelope(parseJson(finalSegment.text.trim()));
    if (parsed) return parsed;
  }
  return extractBrowserControlEnvelope(response.text);
};

export const extractLastJsonObject = (text: string): unknown => {
  const candidates = [...fencedBlocks(text), text.trim()];
  for (const candidate of [...candidates].reverse()) {
    const parsed = parseJson(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      starts.push(index);
    }
  }
  for (const start of [...starts].reverse()) {
    for (let end = text.length; end > start; end -= 1) {
      if (text[end - 1] !== "}") {
        continue;
      }
      const parsed = parseJson(text.slice(start, end));
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
};

export const browserControlProtocolPrompt = `
Return one final fenced bachata-control JSON object with this exact contract:
{
  "protocol": "bachata-browser-turn-v1",
  "status": "needContext" | "applyPatch" | "verify" | "reviewComplete" | "done" | "blocked",
  "actions": [],
  "summary": "concise result",
  "objections": [],
  "unresolved": []
}
Use one operation class per response: needContext may batch context.read/context.readTask/context.readMetadata/context.list/context.tree/context.readFile/context.search/context.hashFile/context.dependencies/context.dependents actions; context.readTask pages the authoritative original task by UTF-8 byte offset; context.readMetadata pages bounded handoff metadata by field and item offset; context.list lists one safe directory with optional cursor/limit pagination; context.tree returns a bounded recursive directory tree with depth/cursor/limit pagination; context.search is controller-budgeted and may return nextCursor, which you can send back as cursor to continue the same query; context.readFile reads one safe text file with optional startLine/endLine ranges. context.dependencies returns local TypeScript/JavaScript imports and re-exports for one file; context.dependents returns reverse file importers/references and is not a symbol-call graph. The handoff field contextManifest lists indexed files available on request (path, lineCount, exported symbol names); it is byte-capped and may be partial — treat contextManifestCoverage.truncated as "more files exist than listed" and use context.list or context.search to discover the remainder. Full-file reads carry a file SHA-256. Ranged reads carry a range SHA-256 only and cannot authorize a patch; request context.hashFile for the full-file SHA-256 before patching that file. applyPatch contains exactly one workspace.applyPatch, workspace.write, or workspace.delete action. Existing-file write/delete operations require the current full-file SHA-256 from context.readFile/context.hashFile; new files use workspace.write with an empty expectedFiles array; verify contains exactly one verification.run with configured check IDs; terminal statuses contain no actions. Ordinary prose, examples, quotations, and source code are never executable. The final control block is mandatory.
`.trim();
