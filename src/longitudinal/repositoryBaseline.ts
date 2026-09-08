import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { gitProcessEnvironment } from "../process/safeEnvironment";
import { resolveProcessExecutable } from "../process/processScope";
import type { CycleBaseline } from "./types";
import { byCodeUnitOn } from "../security/ordinal";

const execFileAsync = promisify(execFile);

const MAX_DIRTY_PATHS = 5_000;
export const ABSENT_HASH = "absent";
const HASH_BATCH = 200;

type GitOutput = { ok: boolean; stdout: string };

const gitOutput = async (cwd: string, args: string[]): Promise<GitOutput> => {
  try {
    const environment = gitProcessEnvironment(cwd);
    const result = await execFileAsync(resolveProcessExecutable("git", environment, cwd), args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8_388_608,
      windowsHide: true,
      env: environment,
    });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, stdout: "" };
    if (typeof (error as { code?: unknown }).code === "number") {
      return { ok: false, stdout: String((error as { stdout?: unknown }).stdout ?? "") };
    }
    throw error;
  }
};

type DirtyEntry = { status: string; path: string; origin?: string };

const UNMERGED_STATUS: ReadonlySet<string> = new Set([
  "DD", "AU", "UD", "UA", "DU", "AA", "UU",
]);

export const worktreeIsAbsent = (status: string): boolean => {
  if (UNMERGED_STATUS.has(status)) return status === "DD";
  return status[1] === "D" || (status[0] === "D" && status[1] === " ");
};

export const parsePorcelainEntries = (porcelain: string): DirtyEntry[] => {
  const records = porcelain.split("\u0000").filter((record) => record.length > 0);
  const entries: DirtyEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = status.startsWith("R") || status.startsWith("C");
    const origin = renamed ? records[index + 1] : undefined;
    entries.push({ status, path, ...(origin === undefined ? {} : { origin }) });
    if (renamed) index += 1;
  }
  return entries;
};

export const baselinePathExpectations = (
  entries: readonly DirtyEntry[],
): Map<string, boolean> => {
  const expectations = new Map<string, boolean>();
  const note = (item: string, expectedAbsent: boolean): void => {
    const held = expectations.get(item);
    expectations.set(item, held === undefined ? expectedAbsent : held && expectedAbsent);
  };
  entries.forEach((entry) => {
    note(entry.path, worktreeIsAbsent(entry.status));
    if (entry.origin !== undefined) note(entry.origin, entry.status[0] === "R");
  });
  return expectations;
};

const hashOnePath = async (
  workingDirectory: string,
  item: string,
): Promise<{ hash: string; missing: boolean; failed: boolean }> => {
  const single = await gitOutput(workingDirectory, ["hash-object", "--", item]);
  const value = single.stdout.trim();
  if (single.ok && value.length > 0) {
    return { hash: value, missing: false, failed: false };
  }
  const probe = await stat(path.resolve(workingDirectory, item)).then(
    () => ({ missing: false, failed: false }),
    (error: NodeJS.ErrnoException) =>
      ({ missing: error.code === "ENOENT", failed: error.code !== "ENOENT" }),
  );
  if (probe.missing) return { hash: ABSENT_HASH, missing: true, failed: false };
  return { hash: probe.failed ? "unreadable" : "unhashable", missing: false, failed: true };
};

export const worktreeIsComplete = (
  expectations: ReadonlyMap<string, boolean>,
  hashes: ReadonlyMap<string, string>,
): boolean =>
  [...expectations.entries()].every(([item, expectedAbsent]) => {
    const hash = hashes.get(item);
    if (hash === undefined) return false;
    if (hash === "unreadable" || hash === "unhashable") return false;
    return expectedAbsent ? hash === ABSENT_HASH : hash !== ABSENT_HASH;
  });

const hashWorktreePaths = async (
  workingDirectory: string,
  expectations: ReadonlyMap<string, boolean>,
): Promise<{ hashes: Map<string, string>; complete: boolean }> => {
  const hashes = new Map<string, string>();
  const all = [...expectations.keys()];
  const hashable = all.filter((item) => !item.includes("\n"));
  const expectedPresent = hashable.filter((item) => expectations.get(item) !== true);
  const expectedAbsent = hashable.filter((item) => expectations.get(item) === true);

  for (let index = 0; index < expectedPresent.length; index += HASH_BATCH) {
    const batch = expectedPresent.slice(index, index + HASH_BATCH);
    const result = await gitOutput(workingDirectory, ["hash-object", "--", ...batch]);
    const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (result.ok && lines.length === batch.length) {
      batch.forEach((item, offset) => {
        const hash = lines[offset];
        if (hash !== undefined) hashes.set(item, hash);
      });
      continue;
    }
    for (const item of batch) {
      hashes.set(item, (await hashOnePath(workingDirectory, item)).hash);
    }
  }

  for (const item of expectedAbsent) {
    hashes.set(item, (await hashOnePath(workingDirectory, item)).hash);
  }

  return {
    hashes,
    complete: hashable.length === all.length && worktreeIsComplete(expectations, hashes),
  };
};

const indexEntries = async (
  workingDirectory: string,
  paths: readonly string[],
): Promise<{ staged: Map<string, string[]>; complete: boolean }> => {
  const staged = new Map<string, string[]>();
  const listable = paths.filter((item) => !item.includes("\n"));
  let complete = listable.length === paths.length;
  for (let index = 0; index < listable.length; index += HASH_BATCH) {
    const batch = listable.slice(index, index + HASH_BATCH);
    const result = await gitOutput(
      workingDirectory,
      ["ls-files", "--stage", "-z", "--", ...batch],
    );
    if (!result.ok) {
      complete = false;
      continue;
    }
    result.stdout
      .split("\u0000")
      .filter((record) => record.length > 0)
      .forEach((record) => {
        const tab = record.indexOf("\t");
        if (tab === -1) {
          complete = false;
          return;
        }
        const meta = record.slice(0, tab).split(" ");
        const entryPath = record.slice(tab + 1);
        if (meta.length < 3) {
          complete = false;
          return;
        }
        const held = staged.get(entryPath) ?? [];
        held.push(`${meta[2]}:${meta[0]}:${meta[1]}`);
        staged.set(entryPath, held);
      });
  }
  return { staged, complete };
};

const stagedLabel = (
  staged: ReadonlyMap<string, readonly string[]>,
  entryPath: string | undefined,
): string => {
  if (entryPath === undefined) return "";
  const stages = staged.get(entryPath);
  return stages === undefined ? "unstaged" : [...stages].sort().join(",");
};

export const contentDigest = (
  entries: readonly DirtyEntry[],
  hashes: ReadonlyMap<string, string>,
  staged: ReadonlyMap<string, readonly string[]> = new Map(),
): string =>
  `WT${createHash("sha256")
    .update(JSON.stringify(
      [...entries]
        .map((entry) => [
          entry.status,
          entry.path,
          entry.origin ?? "",
          hashes.get(entry.path) ?? "absent",
          entry.origin === undefined ? "" : hashes.get(entry.origin) ?? "absent",
          stagedLabel(staged, entry.path),
          stagedLabel(staged, entry.origin),
        ])
        .sort(byCodeUnitOn((entry) => `${entry[1]}\u0000${entry[2]}`)),
    ))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase()}`;

export const resolveRepositoryTopLevel = async (
  workingDirectory: string,
): Promise<string | undefined> => {
  const top = await gitOutput(workingDirectory, ["rev-parse", "--show-toplevel"]);
  const value = top.stdout.trim();
  if (!top.ok || value.length === 0) return undefined;
  return path.resolve(workingDirectory, value);
};

export const captureCycleBaseline = async (
  workingDirectory: string | undefined,
  recordedAt: string,
): Promise<CycleBaseline | undefined> => {
  if (workingDirectory === undefined || workingDirectory.trim().length === 0) return undefined;
  const probe = await gitOutput(workingDirectory, ["rev-parse", "--is-inside-work-tree"]);
  if (!probe.ok || probe.stdout.trim() !== "true") return undefined;
  const topLevel = await resolveRepositoryTopLevel(workingDirectory);
  if (topLevel === undefined) return undefined;
  const head = await gitOutput(topLevel, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const branch = await gitOutput(topLevel, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await gitOutput(
    topLevel,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );
  if (!status.ok) return undefined;
  const entries = parsePorcelainEntries(status.stdout);
  const truncated = entries.length > MAX_DIRTY_PATHS;
  const considered = truncated ? entries.slice(0, MAX_DIRTY_PATHS) : entries;
  const allPaths = Array.from(new Set(considered.flatMap(
    (entry) => (entry.origin === undefined ? [entry.path] : [entry.path, entry.origin]),
  )));
  const hashed = await hashWorktreePaths(
    topLevel,
    baselinePathExpectations(considered),
  );
  const indexed = await indexEntries(topLevel, allPaths);
  const branchName = branch.ok ? branch.stdout.trim() : "";
  return {
    commit: head.ok ? head.stdout.trim() : "",
    ...(branchName.length === 0 || branchName === "HEAD" ? {} : { branch: branchName }),
    dirty: entries.length > 0,
    worktreeDigest: contentDigest(considered, hashed.hashes, indexed.staged),
    contentComplete: hashed.complete && indexed.complete && !truncated,
    capturedAt: recordedAt,
  };
};

export const baselineDrift = (
  baseline: CycleBaseline | undefined,
  current: CycleBaseline | undefined,
): string[] => {
  if (baseline === undefined) return [];
  if (current === undefined) {
    return [
      "Bachata could not read the current repository state, so it cannot say whether this cycle still describes it",
    ];
  }
  const reasons: string[] = [];
  if (baseline.commit !== current.commit) {
    reasons.push(
      `the repository moved from ${baseline.commit.slice(0, 12) || "an unborn HEAD"} to ${current.commit.slice(0, 12) || "an unborn HEAD"} since this cycle was baselined`,
    );
  }
  if (baseline.branch !== current.branch) {
    reasons.push(
      `the checked-out branch changed from ${baseline.branch ?? "a detached HEAD"} to ${current.branch ?? "a detached HEAD"} since this cycle was baselined`,
    );
  }
  if (baseline.contentComplete === false || current.contentComplete === false) {
    reasons.push(
      "Bachata could not fingerprint the whole working tree, so it treats this candidate as changed",
    );
    return reasons;
  }
  if (baseline.commit === current.commit && baseline.worktreeDigest !== current.worktreeDigest) {
    reasons.push("the working tree changed since this cycle was baselined");
  }
  return reasons;
};

export const baselineIdentity = (baseline: CycleBaseline | undefined): string =>
  baseline === undefined
    ? ""
    : `${baseline.commit}|${baseline.branch ?? ""}|${String(baseline.dirty)}|${baseline.worktreeDigest}|${String(baseline.contentComplete === true)}`;

export const baselineIsSameCandidate = (
  left: CycleBaseline | undefined,
  right: CycleBaseline | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.contentComplete === true &&
  right.contentComplete === true &&
  baselineIdentity(left) === baselineIdentity(right);

export const baselineLabel = (baseline: CycleBaseline): string =>
  `${baseline.branch ?? "detached"}@${baseline.commit.slice(0, 12) || "unborn"}${baseline.dirty ? " +dirty" : ""}`;
