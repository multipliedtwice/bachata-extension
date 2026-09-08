export type PatchHunkSummary = {
  index: number;
  header: string;
  added: number;
  removed: number;
  preview: string;
};

export type PatchFileSummary = {
  path: string;
  oldPath?: string;
  binary: boolean;
  renamed: boolean;
  modeChanged: boolean;
  wholeFileOnly: boolean;
  hunks: PatchHunkSummary[];
};

export type PatchHunkReference = { path: string; index: number };

export type PatchSelection = {
  paths?: string[];
  hunks?: PatchHunkReference[];
};

export const parsePatchHunkReferences = (value: unknown): PatchHunkReference[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const candidate = item as Record<string, unknown>;
        const path = candidate.path;
        const index = candidate.index;
        return typeof path === "string" && typeof index === "number" &&
          Number.isInteger(index) && index >= 0
          ? [{ path, index }]
          : [];
      })
    : [];

const octalEscape = /\\([0-7]{3})/gu;

const unquotePath = (value: string): string => {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const decoded = value
    .slice(1, -1)
    .replace(octalEscape, (_match, digits: string) => String.fromCharCode(parseInt(digits, 8)))
    .replace(/\\t/gu, "\t")
    .replace(/\\n/gu, "\n")
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, "\\");
  return Buffer.from(decoded, "binary").toString("utf8");
};

const stripPrefix = (value: string): string => {
  const unquoted = unquotePath(value);
  return unquoted.startsWith("a/") || unquoted.startsWith("b/") ? unquoted.slice(2) : unquoted;
};

const headerPath = (lines: string[], marker: string): string | undefined => {
  const line = lines.find((item) => item.startsWith(marker));
  if (line === undefined) return undefined;
  const value = line.slice(marker.length).split("\t")[0] ?? "";
  return value === "/dev/null" ? undefined : stripPrefix(value);
};

const quotedSpan = (value: string, start: number): number => {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === '"') return index + 1;
  }
  return -1;
};

const diffGitPaths = (line: string): { old?: string; next?: string } => {
  const marker = "diff --git ";
  if (!line.startsWith(marker)) return {};
  const rest = line.slice(marker.length);
  if (rest.startsWith('"')) {
    const firstEnd = quotedSpan(rest, 0);
    if (firstEnd === -1 || rest[firstEnd] !== " " || rest[firstEnd + 1] !== '"') return {};
    const secondEnd = quotedSpan(rest, firstEnd + 1);
    if (secondEnd === -1) return {};
    return {
      old: stripPrefix(rest.slice(0, firstEnd)),
      next: stripPrefix(rest.slice(firstEnd + 1, secondEnd)),
    };
  }
  if (!rest.startsWith("a/")) return {};
  for (let index = 3; index + 3 <= rest.length; index += 1) {
    if (!rest.startsWith(" b/", index)) continue;
    const left = rest.slice(2, index);
    const right = rest.slice(index + 3);
    if (left === right) return { old: left, next: right };
  }
  return {};
};

const markerPath = (lines: string[], marker: string): string | undefined => {
  const line = lines.find((item) => item.startsWith(marker));
  return line === undefined ? undefined : unquotePath(line.slice(marker.length));
};

type PatchSection = {
  summary: PatchFileSummary;
  header: string[];
  hunkLines: string[][];
};

const sectionOf = (lines: string[]): PatchSection => {
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  const hunkLines: string[][] = [];
  (firstHunk === -1 ? [] : lines.slice(firstHunk)).forEach((line) => {
    if (line.startsWith("@@")) hunkLines.push([line]);
    else hunkLines.at(-1)?.push(line);
  });
  const named = diffGitPaths(lines[0] ?? "");
  const renamedTo = markerPath(header, "rename to ");
  const renamedFrom = markerPath(header, "rename from ");
  const copiedTo = markerPath(header, "copy to ");
  const copiedFrom = markerPath(header, "copy from ");
  const newPath = renamedTo ?? copiedTo ?? headerPath(header, "+++ ");
  const oldPath = renamedFrom ?? copiedFrom ?? headerPath(header, "--- ");
  const path = newPath ?? oldPath ?? named.next ?? named.old ?? "";
  const binary = header.some((line) =>
    line.startsWith("GIT binary patch") || line.startsWith("Binary files "));
  const renamed = renamedFrom !== undefined;
  const copied = copiedFrom !== undefined;
  const modeChanged = header.some((line) =>
    line.startsWith("old mode ") || line.startsWith("new mode ") ||
    line.startsWith("new file mode ") || line.startsWith("deleted file mode "));
  const unresolved = path.length === 0;
  const hunks = hunkLines.map((hunk, index) => ({
    index,
    header: hunk[0] ?? "",
    added: hunk.filter((line) => line.startsWith("+")).length,
    removed: hunk.filter((line) => line.startsWith("-")).length,
    preview: hunk.slice(1, 13).join("\n"),
  }));
  return {
    summary: {
      path,
      ...(oldPath !== undefined && oldPath !== path ? { oldPath } : {}),
      binary,
      renamed: renamed || copied,
      modeChanged,
      wholeFileOnly:
        binary || renamed || copied || modeChanged || unresolved || hunks.length === 0,
      hunks,
    },
    header,
    hunkLines,
  };
};

export const PATCH_FILE_LIMIT = 500;
export const PATCH_HUNK_LIMIT = 200;
const PREVIEW_LINE_LIMIT = 400;

const boundedPreview = (preview: string): string =>
  preview
    .split("\n")
    .map((line) => line.length > PREVIEW_LINE_LIMIT ? `${line.slice(0, PREVIEW_LINE_LIMIT)}…` : line)
    .join("\n");

export const boundPatchFiles = (
  files: PatchFileSummary[],
): { files: PatchFileSummary[]; truncated?: string } => {
  const droppedFiles = Math.max(0, files.length - PATCH_FILE_LIMIT);
  let droppedHunks = 0;
  const bounded = files.slice(0, PATCH_FILE_LIMIT).map((file) => {
    droppedHunks += Math.max(0, file.hunks.length - PATCH_HUNK_LIMIT);
    return {
      ...file,
      hunks: file.hunks.slice(0, PATCH_HUNK_LIMIT).map((hunk) => ({
        ...hunk,
        preview: boundedPreview(hunk.preview),
      })),
    };
  });
  const notes = [
    ...(droppedFiles > 0 ? [`${String(droppedFiles)} more changed file${droppedFiles === 1 ? "" : "s"}`] : []),
    ...(droppedHunks > 0 ? [`${String(droppedHunks)} more hunk${droppedHunks === 1 ? "" : "s"}`] : []),
  ];
  return {
    files: bounded,
    ...(notes.length === 0
      ? {}
      : { truncated: `This view omits ${notes.join(" and ")}. Export the patch to see the whole diff, or apply the whole run.` }),
  };
};

const splitSections = (patch: string): string[][] => {
  const sections: string[][] = [];
  patch.split("\n").forEach((line) => {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else sections.at(-1)?.push(line);
  });
  return sections;
};

export const parsePatchFiles = (patch: string): PatchFileSummary[] =>
  splitSections(patch).map((lines) => sectionOf(lines).summary);

const withoutTrailingBlanks = (lines: string[]): string[] =>
  lines.slice(0, lines.reduce((last, line, index) => line.length > 0 ? index + 1 : last, 0));

export const selectionIsEmpty = (selection: PatchSelection | undefined): boolean =>
  (selection?.paths ?? []).length === 0 && (selection?.hunks ?? []).length === 0;

export const selectPatch = (
  patch: string,
  selection: PatchSelection,
): { patch: string; refusal?: string } => {
  if (selectionIsEmpty(selection)) return { patch };
  const paths = selection.paths ?? [];
  const hunkReferences = selection.hunks ?? [];
  const sections = splitSections(patch).map(sectionOf);
  const byPath = new Map(sections.map((section) => [section.summary.path, section]));
  const unknownPaths = [
    ...paths,
    ...hunkReferences.map((reference) => reference.path),
  ].filter((candidate) => !byPath.has(candidate));
  if (unknownPaths.length > 0) {
    return {
      patch: "",
      refusal: `Bachata refuses to apply paths this run did not change: ${Array.from(new Set(unknownPaths)).slice(0, 20).join(", ")}`,
    };
  }
  const partialWholeFileOnly = hunkReferences
    .filter((reference) => byPath.get(reference.path)?.summary.wholeFileOnly === true)
    .map((reference) => reference.path);
  if (partialWholeFileOnly.length > 0) {
    const reason = partialWholeFileOnly.some((candidate) =>
      byPath.get(candidate)?.summary.modeChanged === true &&
      byPath.get(candidate)?.summary.binary !== true &&
      byPath.get(candidate)?.summary.renamed !== true)
      ? "a file whose permissions this run also changed"
      : "a binary or renamed file";
    return {
      patch: "",
      refusal: `Bachata cannot apply part of ${reason}: ${Array.from(new Set(partialWholeFileOnly)).slice(0, 20).join(", ")}. Select the whole file instead.`,
    };
  }
  const outOfRange = hunkReferences.filter((reference) =>
    reference.index >= (byPath.get(reference.path)?.summary.hunks.length ?? 0));
  if (outOfRange.length > 0) {
    return {
      patch: "",
      refusal: "Bachata refuses a hunk selection that is not part of this run's diff. Reload the run result and select again.",
    };
  }
  const selectedPaths = new Set(paths);
  const selectedHunks = hunkReferences.reduce<Map<string, Set<number>>>((result, reference) => {
    const existing = result.get(reference.path) ?? new Set<number>();
    existing.add(reference.index);
    return result.set(reference.path, existing);
  }, new Map());
  const emitted = sections.flatMap((section) => {
    const path = section.summary.path;
    if (selectedPaths.has(path)) {
      return [withoutTrailingBlanks([...section.header, ...section.hunkLines.flat()]).join("\n")];
    }
    const hunks = selectedHunks.get(path);
    if (!hunks || hunks.size === 0) return [];
    const kept = section.hunkLines.filter((_hunk, index) => hunks.has(index));
    return [withoutTrailingBlanks([...section.header, ...kept.flat()]).join("\n")];
  });
  return { patch: emitted.length === 0 ? "" : `${emitted.join("\n")}\n` };
};
