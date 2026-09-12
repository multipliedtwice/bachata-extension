import { createHash } from "node:crypto";
import * as path from "node:path";
import { createBrowserActionCandidate, patchRisk, type BrowserActionCandidate } from "./actions";
import type { BrowserBridgeServer } from "./bridgeServer";
import type { BrowserContextReferences } from "./contextReferences";
import type { BrowserControlEnvelope } from "./controlProtocol";
import { deliverableLimits, readDeliverableZip, type DeliverableFile } from "./deliverableArchive";
import { deliverableText, filesToDeliverablePatch, validateDeliverablePatch, type DeliverableChangeOptions } from "./deliverableChanges";
import type { CapturedAsset, CapturedResponse } from "./protocol";
import { redactFreeFormText } from "../security/redact";

export type PreparedDeliverable =
  | { kind: "none" }
  | { kind: "correction"; message: string }
  | { kind: "unchanged"; message: string }
  | { kind: "changes"; action: BrowserActionCandidate; envelope: BrowserControlEnvelope };

export type DeliverableOptions = Omit<DeliverableChangeOptions, "knownFiles"> & {
  references: BrowserContextReferences;
  fetchAsset: BrowserBridgeServer["fetchAsset"];
  hasControlActions: boolean;
};

const patchName = (name: string): boolean => /\.(?:patch|diff)$/iu.test(name);
const archiveName = (name: string): boolean => /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|zst|tbz2|txz|lz|lzma|lz4|cab|iso)$/iu.test(name);
const sourceName = (name: string): boolean => /\.(?:[cm]?[jt]sx?|json|html?|css|scss|sass|less|vue|svelte|py|rb|php|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|sql|ya?ml|toml|xml|svg|md|mdx|txt|ini|properties|graphql|proto|r|ex|exs|erl|hrl|fs|fsx|dart|lua|zig|sol)$/iu.test(name)
  || /(?:^|\/)(?:Dockerfile|Makefile|CMakeLists\.txt)$/u.test(name);
const relevantAsset = (asset: CapturedAsset): boolean => patchName(asset.name) || archiveName(asset.name)
  || (sourceName(asset.name) && ["generatedFile", "codeArtifact", "artifact"].includes(asset.kind));

export const fetchDeliverableBytes = async (
  asset: CapturedAsset, fetchAsset: BrowserBridgeServer["fetchAsset"], signal: AbortSignal, maximumBytes: number,
): Promise<Buffer> => {
  if (!asset.downloadAvailable) throw new Error("The deliverable is not downloadable; attach the actual file or return structured workspace changes");
  if (asset.size !== undefined && asset.size > maximumBytes) throw new Error("Deliverable exceeds the download limit");
  const chunks: Buffer[] = [];
  let size = 0;
  let sequence = 0;
  let started = false;
  let completed = false;
  let declaredSize: number | undefined;
  const digest = createHash("sha256");
  for await (const event of fetchAsset(asset.id, maximumBytes, signal)) {
    signal.throwIfAborted();
    if (completed || event.assetId !== asset.id) throw new Error("Deliverable transfer identity or order is invalid");
    if (event.type === "start") {
      if (started || (event.size !== undefined && event.size > maximumBytes)) throw new Error("Deliverable transfer start is invalid");
      if (event.name !== asset.name) throw new Error("Deliverable identity changed during download");
      started = true;
      declaredSize = event.size;
    } else if (event.type === "chunk") {
      if (!started || sequence >= 8192 || event.sequence !== sequence++ || event.data.length > maximumBytes - size) throw new Error("Deliverable transfer is out of order or oversized");
      chunks.push(event.data);
      digest.update(event.data);
      size += event.data.length;
    } else {
      if (!started || event.size !== size || (declaredSize !== undefined && declaredSize !== size)
        || (asset.size !== undefined && asset.size !== size) || digest.digest("hex") !== event.sha256) {
        throw new Error("Deliverable transfer failed integrity validation");
      }
      completed = true;
    }
  }
  signal.throwIfAborted();
  if (!completed) throw new Error("Deliverable download ended before completion");
  return Buffer.concat(chunks, size);
};

const inlineDeliverables = (response: CapturedResponse): { patches: string[]; files: DeliverableFile[] } => {
  const patches: string[] = [];
  const files: DeliverableFile[] = [];
  for (let index = 0; index < response.segments.length; index++) {
    const segment = response.segments[index];
    if (segment?.type !== "codeBlock") continue;
    const previous = response.segments[index - 1];
    const preceding = previous?.type === "text" ? previous.text.slice(-1024).trim() : "";
    if (/\b(?:example|quoted|do not apply|don't apply|illustration)\b/iu.test(preceding)) continue;
    if (["diff", "patch"].includes(segment.language?.toLowerCase() ?? "")
      && /(?:apply|use|here is|here's|updated|attached|changes)/iu.test(preceding)) {
      patches.push(segment.text);
      continue;
    }
    const file = /(?:^|\n)(?:#{1,6}\s+|(?:File|Updated file|Replace file):\s*)`?([^`\n]+?)`?\s*$/iu.exec(preceding)?.[1];
    if (file && sourceName(file)) files.push({ path: file, data: Buffer.from(segment.text, "utf8") });
  }
  if (!patches.length && !files.length && /^(?:diff --git |--- a\/)/u.test(response.text)) patches.push(response.text);
  return { patches, files };
};

export const prepareBrowserDeliverable = async (response: CapturedResponse, options: DeliverableOptions): Promise<PreparedDeliverable> => {
  const inline = inlineDeliverables(response);
  const assets = response.assets.filter(relevantAsset);
  const hasLink = /\[[^\]\n]*\]\((?:sandbox:|https?:)[^\s)]*\.(?:zip|patch|diff)(?:[?#][^\s)]*)?\)/iu.test(response.text);
  if (!assets.length && !inline.patches.length && !inline.files.length && !hasLink) return { kind: "none" };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), deliverableLimits.timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const changeOptions: DeliverableChangeOptions = { ...options, signal, knownFiles: options.references.knownFileDigests() };
  try {
    signal.throwIfAborted();
    if (options.hasControlActions) throw new Error("Return either executable control actions or a deliverable, not both, so changes cannot be applied twice");
    if (assets.length > deliverableLimits.assets) throw new Error("Too many deliverables; return one source archive or a smaller batch");
    if (assets.length && (inline.patches.length || inline.files.length)) throw new Error("Both inline changes and downloadable changes were returned; provide one authoritative representation");
    if (!assets.length && !inline.patches.length && !inline.files.length) throw new Error("The deliverable link was not captured as a downloadable asset; attach the actual file or return structured workspace changes");
    let downloadBytes = 0;
    let archive = false;
    const patches = [...inline.patches];
    const files = [...inline.files];
    for (const asset of assets) {
      const data = await fetchDeliverableBytes(asset, options.fetchAsset, signal, deliverableLimits.compressedBytes - downloadBytes);
      downloadBytes += data.length;
      if (patchName(asset.name)) patches.push(deliverableText(data));
      else if (/\.zip$/iu.test(asset.name)) {
        if (assets.length !== 1) throw new Error("Multiple deliverables with an archive are ambiguous; return one authoritative source archive");
        archive = true;
        const entries = await readDeliverableZip(data, signal);
        if (entries.length && entries.every((entry) => patchName(entry.path))) patches.push(...entries.map((entry) => deliverableText(entry.data)));
        else files.push(...entries);
      } else if (archiveName(asset.name)) throw new Error("This archive format is unsupported; return a ZIP of source files or a unified patch");
      else {
        let target = asset.name;
        if (!target.includes("/")) {
          const matches = [...changeOptions.knownFiles.keys()].filter((name) => path.posix.basename(name) === target);
          if (matches.length > 1) throw new Error("The returned filename matches multiple workspace files; return workspace-relative paths in a ZIP");
          if (matches.length === 1) target = matches[0]!;
          else throw new Error("A standalone source file needs an unambiguous workspace path; return a source ZIP or a structured write");
        }
        files.push({ path: target, data });
      }
    }
    if (patches.length && files.length) throw new Error("Mixed patches and replacement files are ambiguous; return one representation");
    const prepared = patches.length
      ? await validateDeliverablePatch(patches.join("\n"), changeOptions)
      : await filesToDeliverablePatch(files, changeOptions, archive);
    if (!prepared.changedPaths.length) return { kind: "unchanged", message: "The delivered files already match the workspace. No files were changed. Continue with verification and report the actual outcome." };
    signal.throwIfAborted();
    const action = createBrowserActionCandidate({
      kind: "workspace.applyPatch", patch: prepared.patch, expectedFiles: prepared.expectedFiles,
      risk: patchRisk(prepared.patch), origin: "structured", confidence: "explicit",
      source: { start: 0, end: 0, text: `Validated browser deliverable: ${String(prepared.changedPaths.length)} changed file(s)` },
    });
    return {
      kind: "changes", action,
      envelope: {
        protocol: "bachata-browser-turn-v1", status: "applyPatch",
        actions: [{ kind: "workspace.applyPatch", patch: prepared.patch, expectedFiles: prepared.expectedFiles }],
        summary: action.source.text, objections: [], unresolved: [],
      },
    };
  } catch (error) {
    options.signal.throwIfAborted();
    const detail = error instanceof Error && "path" in error
      ? "A deliverable source file could not be inspected"
      : error instanceof Error ? error.message.slice(0, 16384).split(options.workingDirectory).join(".") : "Deliverable inspection failed";
    const reason = timeout.signal.aborted ? "Deliverable inspection timed out"
      : redactFreeFormText(detail);
    return { kind: "correction", message: `Bachata did not apply the deliverable. ${reason}. Correct the deliverable or request the required current source context, then continue. Do not claim the changes are installed. Omitted archive files are preserved; deletions require an explicit patch. Do not include lockfiles, dependencies, build output or VSIX files.` };
  } finally { clearTimeout(timer); }
};
