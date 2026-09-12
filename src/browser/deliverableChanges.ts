import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import * as path from "node:path";
import { deliverableLimits, deliverablePath, type DeliverableFile } from "./deliverableArchive";
import { assertWorkspacePathAllowed, extractPatchPaths, isRestrictedWorkspacePath, type MutationPolicyContext } from "./mutationPolicy";
import { isBrowserSourcePath } from "./sourceTransferPolicy";

export type DeliverableChangeOptions = {
  workingDirectory: string;
  knownFiles: ReadonlyMap<string, string>;
  mutationContext: MutationPolicyContext;
  signal: AbortSignal;
};

export type DeliverablePatch = {
  patch: string;
  expectedFiles: Array<{ path: string; sha256: string }>;
  changedPaths: string[];
};

type ExistingFile = { data: Buffer; mode: number };
const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const deliverableText = (data: Buffer): string => {
  if (data.length > deliverableLimits.fileBytes || data.includes(0)) throw new Error("Deliverable requires bounded UTF-8 text files");
  try { return textDecoder.decode(data); } catch { throw new Error("Deliverable contains non-UTF-8 content"); }
};

const existingFile = async (relative: string, options: DeliverableChangeOptions): Promise<ExistingFile | undefined> => {
  options.signal.throwIfAborted();
  await assertWorkspacePathAllowed(options.workingDirectory, relative, { scopeMode: "workspace" });
  const root = await realpath(options.workingDirectory);
  const absolute = path.join(root, relative);
  let info;
  try { info = await lstat(absolute); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > deliverableLimits.fileBytes) {
    throw new Error(`Deliverable target is not a bounded regular file: ${relative}`);
  }
  const resolved = await realpath(absolute);
  if (resolved !== absolute) throw new Error(`Deliverable target crosses a symbolic link: ${relative}`);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const data = Buffer.alloc(Math.min(info.size + 1, deliverableLimits.fileBytes + 1));
    let size = 0;
    while (size < data.length) {
      options.signal.throwIfAborted();
      const read = await handle.read(data, size, data.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (size !== info.size || after.size !== info.size || after.ino !== info.ino || after.dev !== info.dev || after.mtimeMs !== info.mtimeMs) {
      throw new Error(`Deliverable target changed during inspection: ${relative}`);
    }
    return { data: data.subarray(0, size), mode: info.mode & 0o111 ? 0o100755 : 0o100644 };
  } finally { await handle.close(); }
};

const excluded = (relative: string): boolean => !isBrowserSourcePath(relative)
  || relative.split("/").some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"));

const mapArchiveRoot = async (files: DeliverableFile[], options: DeliverableChangeOptions): Promise<DeliverableFile[]> => {
  const roots = new Set<string>();
  const directory = await opendir(options.workingDirectory);
  for await (const entry of directory) {
    options.signal.throwIfAborted();
    if (roots.size >= deliverableLimits.entries) throw new Error("Workspace root is too wide to resolve deliverable paths");
    roots.add(entry.name);
  }
  const first = files[0]?.path.split("/")[0];
  if (!first || !files.every((file) => file.path.startsWith(`${first}/`))) return files;
  const direct = roots.has(first);
  const stripped = files.some((file) => roots.has(file.path.split("/")[1] ?? ""));
  if (direct && stripped) throw new Error("Archive root is ambiguous; return paths relative to the workspace root");
  if (direct) return files;
  if (stripped || first === path.basename(options.workingDirectory)) {
    return files.map((file) => ({ ...file, path: file.path.slice(first.length + 1) }));
  }
  throw new Error("Archive root cannot be resolved; return a ZIP with workspace-relative file paths or structured writes");
};

const hunkLines = (text: string, prefix: string): { count: number; body: string } => {
  if (!text) return { count: 0, body: "" };
  const lines = text.split("\n");
  const newline = lines.at(-1) === "";
  if (newline) lines.pop();
  return {
    count: lines.length,
    body: lines.map((line) => `${prefix}${line}\n`).join("") + (newline ? "" : "\\ No newline at end of file\n"),
  };
};

const filePatch = (relative: string, before: ExistingFile | undefined, after: Buffer): string => {
  const removed = hunkLines(before ? deliverableText(before.data) : "", "-");
  const added = hunkLines(deliverableText(after), "+");
  const oldPath = JSON.stringify(`a/${relative}`);
  const newPath = JSON.stringify(`b/${relative}`);
  const header = `diff --git ${oldPath} ${newPath}\n${before ? "" : "new file mode 100644\n"}`;
  if (!before && !after.length) return `${header}index 0000000..e69de29\n`;
  return `${header}--- ${before ? oldPath : "/dev/null"}\n+++ ${newPath}\n@@ -${removed.count ? 1 : 0},${removed.count} +${added.count ? 1 : 0},${added.count} @@\n${removed.body}${added.body}`;
};

export const filesToDeliverablePatch = async (
  input: DeliverableFile[], options: DeliverableChangeOptions, archive: boolean,
): Promise<DeliverablePatch> => {
  if (input.length > deliverableLimits.entries) throw new Error("Deliverable has too many files");
  for (const file of input) {
    deliverablePath(file.path);
    if (file.data.length > deliverableLimits.fileBytes) throw new Error("Deliverable file exceeds its size limit");
  }
  const eligible = input.filter((file) => !excluded(file.path));
  if (!eligible.length) throw new Error("Deliverable contains no eligible source files");
  const files = archive ? await mapArchiveRoot(eligible, options) : eligible;
  const result: DeliverablePatch = { patch: "", expectedFiles: [], changedPaths: [] };
  const paths = new Set<string>();
  const missingVersions: string[] = [];
  let total = 0;
  let patchBytes = 0;
  for (const file of files) {
    options.signal.throwIfAborted();
    const relative = deliverablePath(file.path);
    const key = relative.normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new Error("Deliverable contains colliding file paths");
    paths.add(key);
    if (excluded(relative)) continue;
    if (isRestrictedWorkspacePath(relative)) throw new Error("Deliverable contains a restricted file");
    total += file.data.length;
    if (total > deliverableLimits.expandedBytes) throw new Error("Deliverable exceeds the total size limit");
    const before = await existingFile(relative, options);
    if (before?.data.equals(file.data)) continue;
    if (options.mutationContext.readOnly) throw new Error("This participant is read-only; returned changes cannot be applied");
    await assertWorkspacePathAllowed(options.workingDirectory, relative, options.mutationContext);
    if (before) {
      const expected = options.knownFiles.get(relative);
      if (!expected || digest(before.data) !== expected) {
        missingVersions.push(relative);
        continue;
      }
      result.expectedFiles.push({ path: relative, sha256: expected });
    }
    result.changedPaths.push(relative);
    if (result.changedPaths.length > deliverableLimits.changedFiles) throw new Error("Deliverable changes too many files; return smaller batches");
    const patch = filePatch(relative, before, file.data);
    patchBytes += Buffer.byteLength(patch, "utf8");
    if (patchBytes > deliverableLimits.patchBytes) throw new Error("Deliverable patch exceeds the size limit; return smaller batches");
    result.patch += patch;
  }
  if (missingVersions.length) {
    throw new Error(`Read the current complete source files and regenerate the deliverable because their versions are missing or stale: ${JSON.stringify(missingVersions)}. Use smaller batches if needed`);
  }
  return result;
};

export const validateDeliverablePatch = async (patch: string, options: DeliverableChangeOptions): Promise<DeliverablePatch> => {
  if (Buffer.byteLength(patch, "utf8") > deliverableLimits.patchBytes) throw new Error("Deliverable patch exceeds the size limit");
  if (!/^diff --git |^--- /mu.test(patch) || /^GIT binary patch|^Binary files |^diff --cc |^\*\*\* Begin Patch/mu.test(patch)) {
    throw new Error("Return a complete UTF-8 unified diff or source ZIP; this patch format is unsupported");
  }
  const targets = extractPatchPaths(patch);
  if (!targets.length || targets.length > deliverableLimits.changedFiles) throw new Error("Deliverable patch has no usable targets or too many targets");
  const expectedFiles: DeliverablePatch["expectedFiles"] = [];
  const pathKeys = new Set<string>();
  for (const target of targets) {
    const relative = deliverablePath(target);
    const key = relative.normalize("NFC").toLowerCase();
    if (pathKeys.has(key)) throw new Error("Deliverable patch contains case-colliding paths");
    pathKeys.add(key);
    if (excluded(relative) || isRestrictedWorkspacePath(relative)) throw new Error("Deliverable patch targets an excluded or restricted file");
    const before = await existingFile(relative, options);
    if (!before) continue;
    const expected = options.knownFiles.get(relative);
    if (!expected || digest(before.data) !== expected) {
      throw new Error(`Read the current complete file ${JSON.stringify(relative)} and regenerate the patch; its source version is missing or stale`);
    }
    expectedFiles.push({ path: relative, sha256: expected });
  }
  return { patch, expectedFiles, changedPaths: targets };
};
