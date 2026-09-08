import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";

export type LocalDataCategory =
  | "catalog"
  | "transcripts"
  | "attachments"
  | "pipelines"
  | "worktrees";

export type LocalDataEntry = {
  category: LocalDataCategory;
  label: string;
  path: string;
  bytes: number;
  fileCount: number;
  removes: string;
  keeps: string;
};

export type ArchivedRunData = {
  conversationId: string;
  title: string;
  updatedAt: string;
  paths: string[];
  bytes: number;
  fileCount: number;
};

const directorySize = async (
  target: string,
): Promise<{ bytes: number; fileCount: number }> => {
  let bytes = 0;
  let fileCount = 0;
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return { bytes: 0, fileCount: 0 };
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(child);
      bytes += nested.bytes;
      fileCount += nested.fileCount;
      continue;
    }
    try {
      const info = await stat(child);
      bytes += info.size;
      fileCount += 1;
    } catch {
      continue;
    }
  }
  return { bytes, fileCount };
};

const fileSize = async (target: string): Promise<{ bytes: number; fileCount: number }> => {
  try {
    const info = await stat(target);
    return { bytes: info.size, fileCount: 1 };
  } catch {
    return { bytes: 0, fileCount: 0 };
  }
};

export const formatBytes = (value: number): string => {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1_048_576) return `${String(Math.round(value / 102.4) / 10)} KiB`;
  if (value < 1_073_741_824) return `${String(Math.round(value / 104_857.6) / 10)} MiB`;
  return `${String(Math.round(value / 107_374_182.4) / 10)} GiB`;
};

export const describeLocalData = async (input: {
  storageRoot: string;
  catalogPath: string;
  retainedWorktrees: string[];
}): Promise<LocalDataEntry[]> => {
  const conversations = path.join(input.storageRoot, "conversations");
  const [catalog, rootTranscript, rootAttachments, pipelines, conversationData] = await Promise.all([
    fileSize(input.catalogPath),
    fileSize(path.join(input.storageRoot, "transcript.jsonl")),
    directorySize(path.join(input.storageRoot, "attachments")),
    directorySize(path.join(input.storageRoot, "pipelines")),
    directorySize(conversations),
  ]);
  const worktrees = await Promise.all(input.retainedWorktrees.map((target) => directorySize(target)));
  return [
    {
      category: "catalog",
      label: "Run catalog and metadata",
      path: input.catalogPath,
      bytes: catalog.bytes,
      fileCount: catalog.fileCount,
      removes: "Every run record, event, structured output, interaction, and Git binding. History search stops working.",
      keeps: "Repository files, worktrees, and any exports you already saved.",
    },
    {
      category: "transcripts",
      label: "Transcripts and per-run storage",
      path: conversations,
      bytes: conversationData.bytes + rootTranscript.bytes,
      fileCount: conversationData.fileCount + rootTranscript.fileCount,
      removes: "Stored transcript previews and per-run files. Runs stay listed with their catalog metadata.",
      keeps: "Catalog metadata, provider-side conversation history, repository files.",
    },
    {
      category: "attachments",
      label: "Attachments",
      path: path.join(input.storageRoot, "attachments"),
      bytes: rootAttachments.bytes,
      fileCount: rootAttachments.fileCount,
      removes: "Image files you attached to runs, stored as ordinary local files.",
      keeps: "Attachment names, sizes, and types recorded in the catalog.",
    },
    {
      category: "pipelines",
      label: "Pipeline snapshots",
      path: path.join(input.storageRoot, "pipelines"),
      bytes: pipelines.bytes,
      fileCount: pipelines.fileCount,
      removes: "Cached pipeline snapshots for this workspace storage.",
      keeps: "Repository-owned pipeline definitions in .bachata/pipelines.",
    },
    {
      category: "worktrees",
      label: "Retained Git worktrees",
      path: input.retainedWorktrees.join(", ") || "none retained",
      bytes: worktrees.reduce((total, entry) => total + entry.bytes, 0),
      fileCount: worktrees.reduce((total, entry) => total + entry.fileCount, 0),
      removes: "Working copies retained for recovery, plus their extension-owned branches.",
      keeps: "Your repository, its commits, and any branch you created yourself.",
    },
  ];
};

/**
 * EX-G6-14. Where one conversation's data actually is.
 *
 * The runtime gives the initial conversation the storage root itself and every later one a
 * directory under `conversations/`. Cleanup computed only the second form, so the initial
 * conversation was offered as `conversations/default` — a path holding nothing, whose deletion
 * removes nothing and leaves the data it was meant to remove where it is.
 *
 * The storage root is never a candidate. It holds the catalog and every other conversation, and
 * a cleanup that offered it would delete all of them to remove one.
 */
export const DEFAULT_CONVERSATION_ID = "default";

export const conversationStorageDirectory = (
  storageRoot: string,
  conversationId: string,
): string => (conversationId === DEFAULT_CONVERSATION_ID
  ? storageRoot
  : path.join(storageRoot, "conversations", conversationId));

/**
 * EX-A5-R15. What one conversation's stored data actually is, as paths.
 *
 * The initial conversation is given the storage root itself, and the root also holds the catalog
 * and every other conversation, so "its directory" is not a thing that can be deleted. Its data
 * is three entries inside that root. Both callers that remove a conversation's data — retention
 * cleanup and a full deletion — read this, so neither can remove a set the other would not.
 */
export const conversationOwnedPaths = (
  storageRoot: string,
  conversationId: string,
): string[] => {
  const directory = conversationStorageDirectory(storageRoot, conversationId);
  return directory === storageRoot
    ? [
        path.join(directory, "transcript.jsonl"),
        path.join(directory, "transcript.index.json"),
        path.join(directory, "attachments"),
      ]
    : [directory];
};

const pathSize = async (target: string): Promise<{ bytes: number; fileCount: number }> => {
  const info = await stat(target).catch(() => undefined);
  if (info === undefined) return { bytes: 0, fileCount: 0 };
  return info.isDirectory() ? await directorySize(target) : { bytes: info.size, fileCount: 1 };
};

export const archivedRunCandidates = async (input: {
  storageRoot: string;
  conversations: Array<{ id: string; title: string; updatedAt: string; archived: boolean; running: boolean }>;
  retentionDays: number;
  nowMs: number;
}): Promise<ArchivedRunData[]> => {
  if (input.retentionDays <= 0) return [];
  const cutoff = input.nowMs - input.retentionDays * 86_400_000;
  const candidates = input.conversations.filter((conversation) => {
    if (!conversation.archived || conversation.running) return false;
    const updated = Date.parse(conversation.updatedAt);
    return Number.isFinite(updated) && updated < cutoff;
  });
  return Promise.all(candidates.map(async (conversation) => {
    const paths = conversationOwnedPaths(input.storageRoot, conversation.id);
    const sizes = await Promise.all(paths.map(pathSize));
    return {
      conversationId: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      paths,
      bytes: sizes.reduce((total, size) => total + size.bytes, 0),
      fileCount: sizes.reduce((total, size) => total + size.fileCount, 0),
    };
  }));
};
