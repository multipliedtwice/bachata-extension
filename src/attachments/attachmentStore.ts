import { constants, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";

import { isPathInsideRoot } from "../process/pathBoundary";

export type AttachmentMetadata = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
};

export type ResolvedAttachments = {
  paths: string[];
  dispose: () => Promise<void>;
};

export type AttachmentBackup = {
  metadata: AttachmentMetadata;
  data: Buffer;
};

export type AttachmentStore = {
  save: (input: {
    id: string;
    name: string;
    mimeType: string;
    dataBase64: string;
    maxBytes: number;
  }) => Promise<AttachmentMetadata>;
  resolvePaths: (
    attachments: AttachmentMetadata[],
    ids: string[],
  ) => Promise<ResolvedAttachments>;
  remove: (attachment: AttachmentMetadata) => Promise<void>;
  clear: (attachments: AttachmentMetadata[]) => Promise<void>;
  backup: (attachments: AttachmentMetadata[]) => Promise<AttachmentBackup[]>;
  restore: (backups: AttachmentBackup[]) => Promise<void>;
};

const mimeExtensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
};

export const TEXT_ATTACHMENT_MIME_TYPES = ["text/plain", "text/markdown", "application/json"] as const;

export const isTextAttachmentMimeType = (mimeType: string): boolean =>
  (TEXT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);

const isDecodableUtf8Text = (data: Buffer): boolean =>
  !data.includes(0) && Buffer.from(data.toString("utf8"), "utf8").equals(data);

const contentMatchesType = (data: Buffer, mimeType: string): boolean =>
  isTextAttachmentMimeType(mimeType)
    ? isDecodableUtf8Text(data)
    : detectedMimeType(data) === mimeType;

const sanitizeName = (value: string): string => {
  const basename = path.basename(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return basename || "attachment";
};

const decodeBase64 = (value: string, maxBytes: number): Buffer => {
  const maximumEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maximumEncodedLength) {
    throw new Error(`Attachment exceeds the ${String(maxBytes)} byte limit`);
  }
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("Attachment data is not valid base64");
  }

  const data = Buffer.from(value, "base64");
  if (data.length > maxBytes) {
    throw new Error(`Attachment exceeds the ${String(maxBytes)} byte limit`);
  }
  const canonicalInput = value.replace(/=+$/, "");
  const canonicalDecoded = data.toString("base64").replace(/=+$/, "");
  if (canonicalInput !== canonicalDecoded) {
    throw new Error("Attachment data is not valid base64");
  }
  return data;
};


const detectedMimeType = (data: Buffer): string | undefined => {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }
  return undefined;
};

const isInside = isPathInsideRoot;

const READ_FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const READ_DIRECTORY_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0);

export const createAttachmentStore = (
  storageDirectory: string,
  options: {
    withMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  } = {},
): AttachmentStore => {
  const resolvedStorageDirectory = path.resolve(storageDirectory);
  const attachmentsDirectory = path.join(
    resolvedStorageDirectory,
    "attachments",
  );
  const snapshotsDirectory = path.join(resolvedStorageDirectory, "attachment-snapshots");
  const withMutation = options.withMutation ?? (async <T>(operation: () => Promise<T>): Promise<T> => operation());

  const assertOwnedDirectory = async (
    directory: string,
    label: string,
  ): Promise<void> => {
    const relative = path.relative(resolvedStorageDirectory, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label} is outside extension storage`);
    }
    const handles: FileHandle[] = [];
    try {
      let current = resolvedStorageDirectory;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const link = await lstat(current).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (link === undefined) return;
        if (link.isSymbolicLink()) {
          throw new Error(
            `${label} passes through a symbolic link at ${current}, so Bachata refuses to read or write through it`,
          );
        }
        if (!link.isDirectory()) {
          throw new Error(`${label} passes through ${current}, which is not a directory`);
        }
        const handle = await open(current, READ_DIRECTORY_FLAGS).catch((error) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ELOOP" || code === "EMLINK" || code === "ENOTDIR") {
            throw new Error(
              `${label} passes through a symbolic link at ${current}, so Bachata refuses to read or write through it`,
            );
          }
          throw error;
        });
        handles.push(handle);
        const opened = await handle.stat();
        // The descriptor, not the pathname, is what the ownership decision rests on: a
        // directory swapped for a symbolic link between the lstat above and this open
        // resolves to a different inode and is refused here.
        if (!opened.isDirectory() || opened.dev !== link.dev || opened.ino !== link.ino) {
          throw new Error(
            `${label} changed while Bachata was validating ${current}, so Bachata refuses to read or write through it`,
          );
        }
      }
    } finally {
      await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    }
    const canonical = await realpath(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (canonical === undefined) return;
    const canonicalStorage = await realpath(resolvedStorageDirectory);
    const expected = path.resolve(
      canonicalStorage,
      path.relative(resolvedStorageDirectory, directory),
    );
    if (path.resolve(canonical) !== expected) {
      throw new Error(`${label} resolves to ${canonical}, which Bachata does not own`);
    }
  };

  const resolveAttachmentPath = (relativePath: string): string => {
    const filePath = path.resolve(resolvedStorageDirectory, relativePath);
    if (!isInside(attachmentsDirectory, filePath)) {
      throw new Error("Attachment path is outside extension storage");
    }
    return filePath;
  };

  const resolveOwnedAttachmentPath = async (relativePath: string): Promise<string> => {
    const filePath = resolveAttachmentPath(relativePath);
    await assertOwnedDirectory(path.dirname(filePath), "The attachment directory");
    return filePath;
  };

  const save: AttachmentStore["save"] = async (input) => {
    const extension = mimeExtensions[input.mimeType];
    if (!extension) {
      throw new Error(`Unsupported attachment type: ${input.mimeType}`);
    }
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
      throw new Error("Attachment byte limit is invalid");
    }

    const data = decodeBase64(input.dataBase64, input.maxBytes);
    if (data.length === 0) {
      throw new Error("Attachment is empty");
    }
    if (!contentMatchesType(data, input.mimeType)) {
      throw new Error(
        isTextAttachmentMimeType(input.mimeType)
          ? "Attachment is not decodable UTF-8 text"
          : "Attachment content does not match its image type",
      );
    }

    return withMutation(async () => {
      await assertOwnedDirectory(attachmentsDirectory, "The attachment directory");
      await mkdir(attachmentsDirectory, { recursive: true });
      const relativePath = path.join("attachments", `${input.id}${extension}`);
      await writeFile(await resolveOwnedAttachmentPath(relativePath), data, {
        flag: "wx",
      });

      return {
        id: input.id,
        name: sanitizeName(input.name),
        mimeType: input.mimeType,
        size: data.length,
        relativePath,
      };
    });
  };

  const readVerifiedAttachment = async (
    attachment: AttachmentMetadata,
  ): Promise<Buffer> => {
    const filePath = await resolveOwnedAttachmentPath(attachment.relativePath);
    const handle = await open(filePath, READ_FILE_FLAGS).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") {
        throw new Error(`Attachment file is a symbolic link: ${attachment.id}`);
      }
      throw error;
    });
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size !== attachment.size) {
        throw new Error(`Attachment file is invalid: ${attachment.id}`);
      }
      const link = await lstat(filePath);
      if (link.dev !== details.dev || link.ino !== details.ino) {
        throw new Error(`Attachment file was replaced while it was being read: ${attachment.id}`);
      }
      const data = await handle.readFile();
      if (data.length !== attachment.size || !contentMatchesType(data, attachment.mimeType)) {
        throw new Error(`Attachment file is invalid: ${attachment.id}`);
      }
      return data;
    } finally {
      await handle.close();
    }
  };

  const resolvePaths: AttachmentStore["resolvePaths"] = async (
    attachments,
    ids,
  ) => {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return { paths: [], dispose: async () => undefined };
    }
    await assertOwnedDirectory(snapshotsDirectory, "The attachment snapshot directory");
    await mkdir(snapshotsDirectory, { recursive: true });
    await assertOwnedDirectory(snapshotsDirectory, "The attachment snapshot directory");
    const snapshotRoot = await mkdtemp(path.join(snapshotsDirectory, "run-"));
    const dispose = async (): Promise<void> => {
      await rm(snapshotRoot, { recursive: true, force: true });
    };
    try {
      const paths = await Promise.all(
        uniqueIds.map(async (id) => {
          const attachment = attachments.find((value) => value.id === id);
          if (!attachment) {
            throw new Error(`Unknown attachment: ${id}`);
          }
          const data = await readVerifiedAttachment(attachment);
          const snapshot = path.join(snapshotRoot, path.basename(attachment.relativePath));
          if (!isInside(snapshotRoot, snapshot)) {
            throw new Error(`Attachment snapshot escapes its directory: ${id}`);
          }
          await writeFile(snapshot, data, { flag: "wx", mode: 0o400 });
          return snapshot;
        }),
      );
      return { paths, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  };

  const removeFile = async (attachment: AttachmentMetadata): Promise<void> => {
    await rm(await resolveOwnedAttachmentPath(attachment.relativePath), {
      force: true,
    });
  };

  const remove: AttachmentStore["remove"] = (attachment) =>
    withMutation(() => removeFile(attachment));

  const clear: AttachmentStore["clear"] = (attachments) =>
    withMutation(async () => {
      await Promise.all(attachments.map(removeFile));
    });

  const backup: AttachmentStore["backup"] = async (attachments) =>
    Promise.all(
      attachments.map(async (attachment) => ({
        metadata: structuredClone(attachment),
        data: await readVerifiedAttachment(attachment),
      })),
    );

  const restore: AttachmentStore["restore"] = (backups) =>
    withMutation(async () => {
      await assertOwnedDirectory(attachmentsDirectory, "The attachment directory");
      await mkdir(attachmentsDirectory, { recursive: true });
      const restoreValues = await Promise.all(backups.map(async ({ metadata, data }) => {
        if (data.length !== metadata.size || !contentMatchesType(data, metadata.mimeType)) {
          throw new Error(`Attachment backup is invalid: ${metadata.id}`);
        }
        return {
          data,
          filePath: await resolveOwnedAttachmentPath(metadata.relativePath),
        };
      }));
      for (const { data, filePath } of restoreValues) {
        await rm(filePath, { force: true });
        await writeFile(filePath, data, { flag: "wx" });
      }
    });

  return { save, resolvePaths, remove, clear, backup, restore };
};
