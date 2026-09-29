import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { BrowserBridgeServer } from "./bridgeServer";
import { deliverablePath, deliverableLimits, readDeliverableZip, type DeliverableFile } from "./deliverableArchive";
import { fetchDeliverableBytes } from "./deliverableTransfer";
import { extractPatchPaths } from "./mutationPolicy";
import type { CapturedResponse } from "./protocol";

export const DELIVERABLE_SELECTION_PROTOCOL = "bachata-deliverable-selection-v2" as const;
export type DeliverableRequirement = { format: "zip" | "markdown" | "listing" | "diff"; paths: readonly string[] };
type SegmentCandidate = { id: string; type: "segment"; sourceSegment: number; paths: string[]; utf8Bytes: number; sha256: string };
type AssetCandidate = { id: string; type: "asset"; assetId: string; name: string; paths: null; completeness: "requiresDownload" };
export type DeliverableSelectionRequest = {
  protocol: typeof DELIVERABLE_SELECTION_PROTOCOL; captureId: string; requirement: DeliverableRequirement;
  candidates: Array<SegmentCandidate | AssetCandidate>; instructions: string;
};
export type DeliverableSelectionDecision = { protocol: typeof DELIVERABLE_SELECTION_PROTOCOL; captureId: string; selectedIds: string[] };
export type DeliverableProvenance = {
  requestId: string; provider: CapturedResponse["provider"]; sessionId: string; finalSessionId: string; conversationIdentity: string;
  evidence: Array<
    { id: string; assetId: string; name: string; sha256: string; utf8Bytes: null; downloadBytes: number;
      entries: Array<{ path: string; bytes: number; sha256: string }> }
    | { id: string; sourceSegment: number; start: number; end: number; sha256: string; utf8Bytes: number;
      transformations?: string[]; preparedSha256?: string; preparedBytes?: number }
  >;
};
export type SelectedDeliverable = {
  kind: "selected"; format: DeliverableRequirement["format"]; captureId: string; provenance: DeliverableProvenance;
  completeness: { requestedPaths: "complete"; captureCoverage: "exact"; providerFidelity: "bestEffort"; taskCorrectness: "unverified" };
  paths: string[]; files: DeliverableFile[]; bytes?: Buffer;
};
export type DeliverableSelectionResult = SelectedDeliverable | { kind: "abstain"; completeness: "unknown"; taskCorrectness: "unverified" };
type SelectionOptions = { signal?: AbortSignal; fetchAsset?: BrowserBridgeServer["fetchAsset"] };
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exactKeys = (value: unknown, keys: string[]): boolean => {
  const object = record(value);
  return object !== undefined && Object.keys(object).sort().join("\0") === [...keys].sort().join("\0");
};
const samePaths = (left: readonly string[], right: readonly string[]): boolean => [...left].sort().join("\0") === [...right].sort().join("\0");
const checkedPaths = (values: unknown): string[] => {
  if (!Array.isArray(values) || values.length < 1 || values.length > deliverableLimits.changedFiles) throw new Error("A bounded required path manifest is mandatory");
  const keys = new Set<string>();
  return values.map((value: unknown) => {
    if (typeof value !== "string") throw new Error("Invalid required path");
    const result = deliverablePath(value), key = result.normalize("NFC").toLowerCase();
    if (keys.has(key)) throw new Error("Duplicate or colliding path");
    keys.add(key); return result;
  });
};
const validateCapture = (capture: CapturedResponse): void => {
  if (!capture || !["chatgpt", "claude", "generic"].includes(capture.provider)
    || capture.captureFormat !== "renderedText" || capture.fidelity !== "bestEffort"
    || ![capture.requestId, capture.sessionId, capture.finalSessionId, capture.finalConversationIdentity].every((value) => typeof value === "string" && value.length > 0)
    || typeof capture.text !== "string" || Buffer.byteLength(capture.text) > deliverableLimits.patchBytes
    || !Array.isArray(capture.segments) || capture.segments.length > 512
    || !Array.isArray(capture.assets) || capture.assets.length > deliverableLimits.assets) throw new Error("Invalid or oversized Bridge capture");
  let offset = 0;
  for (const segment of capture.segments) {
    if (!segment || !["text", "codeBlock", "quote"].includes(segment.type) || typeof segment.text !== "string"
      || segment.start !== offset || segment.end !== offset + segment.text.length
      || capture.text.slice(segment.start, segment.end) !== segment.text) throw new Error("Capture coverage is not exact");
    offset = segment.end;
  }
  if (offset !== capture.text.length) throw new Error("Capture coverage is incomplete");
  const ids = new Set<string>();
  for (const asset of capture.assets) {
    if (!asset || typeof asset.id !== "string" || !asset.id || ids.has(asset.id)
      || asset.provider !== capture.provider || typeof asset.name !== "string") throw new Error("Asset identity is invalid or duplicated");
    ids.add(asset.id);
  }
};
const captureId = (capture: CapturedResponse, requirement: DeliverableRequirement): string => digest(JSON.stringify({
  requestId: capture.requestId, provider: capture.provider, sessionId: capture.sessionId, finalSessionId: capture.finalSessionId,
  conversationIdentity: capture.finalConversationIdentity, text: capture.text, segments: capture.segments, assets: capture.assets, requirement,
}));
const candidatesFor = (capture: CapturedResponse, requirement: DeliverableRequirement): DeliverableSelectionRequest["candidates"] => {
  const candidates: DeliverableSelectionRequest["candidates"] = [];
  if (requirement.format === "zip") {
    for (const asset of capture.assets) if (/\.zip$/iu.test(asset.name) && asset.downloadAvailable
      && ["generatedFile", "artifact"].includes(asset.kind)) candidates.push({ id: `asset:${asset.id}`, type: "asset", assetId: asset.id,
        name: asset.name, paths: null, completeness: "requiresDownload" });
    return candidates;
  }
  for (const [index, segment] of capture.segments.entries()) {
    let targetPaths: string[] | undefined;
    if (requirement.format === "markdown" && segment.type === "codeBlock" && ["md", "markdown"].includes(segment.language?.toLowerCase() ?? "")) {
      const previous = capture.segments[index - 1];
      const match = previous?.type === "text" && /^FILE ([^\r\n]+)$/u.exec(previous.text.trim());
      if (match && requirement.paths.includes(match[1]!)) targetPaths = [match[1]!];
    } else if (requirement.format === "listing" && segment.type === "text") {
      const lines = segment.text.trim().split(/\r?\n/u);
      if (lines.every((line) => /^FILE [^\r\n]+$/u.test(line))) {
        try { targetPaths = checkedPaths(lines.map((line) => line.slice(5))); } catch { continue; }
      }
    } else if (requirement.format === "diff" && segment.type === "codeBlock" && ["diff", "patch"].includes(segment.language?.toLowerCase() ?? "")) {
      const previous = capture.segments[index - 1];
      const labeled = previous?.type === "text" && /^PATCH [^\r\n]+$/u.test(previous.text.trim());
      if (!labeled && capture.segments.length !== 1) continue;
      try {
        targetPaths = checkedPaths(extractPatchPaths(segment.text));
        if (labeled && !targetPaths.includes(previous!.text.trim().slice(6))) continue;
      } catch { continue; }
    }
    if (targetPaths && targetPaths.every((file) => requirement.paths.includes(file))) candidates.push({
      id: `segment:${index}`, type: "segment", sourceSegment: index, paths: targetPaths,
      utf8Bytes: Buffer.byteLength(segment.text), sha256: digest(segment.text),
    });
  }
  return candidates;
};
export const validateDeliverableRequirement = (value: unknown): DeliverableRequirement => {
  const requirement = record(value);
  if (!exactKeys(value, ["format", "paths"]) || !["zip", "markdown", "listing", "diff"].includes(String(requirement?.format))) throw new Error("Invalid deliverable requirement");
  const checked = { format: requirement!.format as DeliverableRequirement["format"], paths: checkedPaths(requirement!.paths) };
  if (Buffer.byteLength(JSON.stringify(checked), "utf8") > 8192) throw new Error("Deliverable requirement exceeds the handoff budget");
  return checked;
};
export const deliverableRequirementPrompt = (requirement: DeliverableRequirement): string => [
  "Controller-requested browser deliverable:", JSON.stringify(validateDeliverableRequirement(requirement)),
  "This exact output manifest is separate from write permissions. Obtain current file versions through controller context before returning changes.",
  ({ zip: "Return one downloadable ZIP whose source paths exactly match this manifest. Preserve workspace-relative paths without a wrapper directory.",
    markdown: "For each requested path return a text label FILE path followed immediately by a markdown code block containing the complete file.",
    listing: "Return one plain text block with exactly one FILE path record per requested path. A listing supplies evidence only; it does not install files or prove they exist.",
    diff: "Return one diff code block, preceded by PATCH path naming a target in the manifest. Its complete target set must match the manifest." })[requirement.format],
  "Return context and verification control requests in separate replies. The deliverable reply must contain no executable control actions. After delivery, continue using actual controller results and complete the normal verification protocol.",
].join("\n");
export const buildDeliverableSelectionRequest = (capture: CapturedResponse, requirement: DeliverableRequirement): DeliverableSelectionRequest => {
  validateCapture(capture);
  const checked = validateDeliverableRequirement(requirement);
  return { protocol: DELIVERABLE_SELECTION_PROTOCOL, captureId: captureId(capture, checked), requirement: checked, candidates: candidatesFor(capture, checked),
    instructions: "The controller has verified explicit source labels and exact capture coverage. Route evidence references only; do not evaluate content quality. Select only supplied candidate IDs. Return exactly protocol, captureId and selectedIds. Never rewrite source, invent paths, declare completeness or use preview text as downloaded files. Select all references needed for the requested path manifest. When one candidate supplies exactly the requested paths, select it. For a single ZIP candidate select its ID: the controller must download and verify its manifest. The controller determines completeness and preserves exact bytes; task correctness remains unverified. Abstain with selectedIds [] when source selection is ambiguous." };
};
export const deliverableSelectionSchema = (request: DeliverableSelectionRequest): Record<string, unknown> => ({ type: "object", additionalProperties: false,
  required: ["protocol", "captureId", "selectedIds"], properties: {
    protocol: { type: "string", enum: [DELIVERABLE_SELECTION_PROTOCOL] }, captureId: { type: "string", enum: [request.captureId] },
    selectedIds: { type: "array", uniqueItems: true, maxItems: request.candidates.length,
      items: request.candidates.length ? { type: "string", enum: request.candidates.map(({ id }) => id) } : { type: "string" } },
  } });
export const unambiguousDeliverableSelection = (request: DeliverableSelectionRequest): DeliverableSelectionDecision => {
  const candidates = request.candidates, paths = candidates.flatMap((candidate) => candidate.paths ?? []);
  const usable = request.requirement.format === "zip" ? candidates.length === 1
    : (request.requirement.format === "markdown" || candidates.length === 1)
      && new Set(paths).size === paths.length && samePaths(paths, request.requirement.paths);
  return { protocol: DELIVERABLE_SELECTION_PROTOCOL, captureId: request.captureId, selectedIds: usable ? candidates.map(({ id }) => id) : [] };
};
const inspectDiff = (bytes: Buffer, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const child = execFile("git", ["apply", "--numstat", "-"], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
    ...(signal ? { signal } : {}) }, (error) => error ? reject(error) : resolve());
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(bytes);
});
export const resolveDeliverableSelection = async (
  capture: CapturedResponse, requirement: DeliverableRequirement, value: unknown, options: SelectionOptions = {},
): Promise<DeliverableSelectionResult> => {
  options.signal?.throwIfAborted();
  const request = buildDeliverableSelectionRequest(capture, requirement), decision = record(value);
  // Download and syntax inspection await external work. Bind this resolution to
  // the validated capture and requirement, rather than later caller mutations.
  capture = { ...capture, segments: capture.segments.map((segment) => ({ ...segment })), assets: capture.assets.map((asset) => ({ ...asset })) };
  requirement = request.requirement;
  if (!exactKeys(value, ["protocol", "captureId", "selectedIds"])
    || decision?.protocol !== DELIVERABLE_SELECTION_PROTOCOL || decision.captureId !== request.captureId
    || !Array.isArray(decision.selectedIds) || decision.selectedIds.length > deliverableLimits.changedFiles
    || !decision.selectedIds.every((id: unknown) => typeof id === "string")
    || new Set(decision.selectedIds).size !== decision.selectedIds.length) throw new Error("Selection contract is invalid or stale");
  const ids = [...decision.selectedIds] as string[], byId = new Map(request.candidates.map((candidate) => [candidate.id, candidate]));
  if (ids.some((id) => !byId.has(id))) throw new Error("Selection invented a source reference");
  if (!ids.length) return { kind: "abstain", completeness: "unknown", taskCorrectness: "unverified" };
  if (requirement.format !== "markdown" && ids.length !== 1) throw new Error("Return one authoritative representation");
  const evidence: DeliverableProvenance["evidence"] = [], files: DeliverableFile[] = [], selectedPaths: string[] = [];
  let bytes: Buffer | undefined;
  for (const id of ids) {
    options.signal?.throwIfAborted();
    const candidate = byId.get(id)!;
    if (candidate.type === "asset") {
      if (!options.fetchAsset || !options.signal) throw new Error("ZIP selection requires a verified download");
      const asset = capture.assets.find((item) => item.id === candidate.assetId)!;
      bytes = await fetchDeliverableBytes(asset, options.fetchAsset, options.signal, deliverableLimits.compressedBytes);
      const entries = await readDeliverableZip(bytes, options.signal);
      selectedPaths.push(...entries.map((entry) => entry.path)); files.push(...entries);
      evidence.push({ id: candidate.id, assetId: asset.id, name: asset.name, sha256: digest(bytes), utf8Bytes: null,
        downloadBytes: bytes.length, entries: entries.map((file) => ({ path: file.path, bytes: file.data.length, sha256: digest(file.data) })) });
    } else {
      const segment = capture.segments[candidate.sourceSegment]!;
      bytes = Buffer.from(segment.text, "utf8");
      const capturedBytes = bytes, transformations: string[] = [];
      selectedPaths.push(...candidate.paths);
      if (requirement.format === "markdown") files.push({ path: candidate.paths[0]!, data: bytes });
      if (requirement.format === "diff") {
        try { await inspectDiff(bytes, options.signal); } catch (error) {
          options.signal?.throwIfAborted();
          if (bytes.at(-1) === 10 || typeof record(error)?.code !== "number") throw error;
          const terminated = Buffer.concat([bytes, Buffer.from("\n")]);
          await inspectDiff(terminated, options.signal); bytes = terminated; transformations.push("appendUnifiedDiffRecordTerminator");
        }
      }
      evidence.push({ id: candidate.id, sourceSegment: candidate.sourceSegment, start: segment.start, end: segment.end,
        sha256: digest(capturedBytes), utf8Bytes: capturedBytes.length,
        ...(transformations.length ? { transformations, preparedSha256: digest(bytes), preparedBytes: bytes.length } : {}) });
    }
  }
  options.signal?.throwIfAborted();
  const admittedPaths = checkedPaths(selectedPaths);
  if (!samePaths(admittedPaths, request.requirement.paths)) throw new Error("Selected representation omits required paths or includes extra paths");
  return { kind: "selected", format: requirement.format, captureId: request.captureId,
    provenance: { requestId: capture.requestId, provider: capture.provider, sessionId: capture.sessionId,
      finalSessionId: capture.finalSessionId, conversationIdentity: capture.finalConversationIdentity, evidence },
    completeness: { requestedPaths: "complete", captureCoverage: "exact", providerFidelity: "bestEffort", taskCorrectness: "unverified" },
    paths: admittedPaths, files, ...(requirement.format === "diff" || requirement.format === "listing" ? { bytes: bytes! } : {}) };
};
