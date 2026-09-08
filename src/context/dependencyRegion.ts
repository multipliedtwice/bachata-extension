import * as path from "node:path";

import { tsJsExtensions } from "./tsJsContext";

// Only TypeScript and JavaScript have a dependency graph here. A readable text file is not
// a graph-capable one, so Markdown, Rust and everything else stays a changed path.
const hasDependencyGraph = (relativePath: string): boolean =>
  tsJsExtensions.has(path.posix.extname(relativePath).toLowerCase());

export type ChangedPath = {
  // The path as Git named it. A rename keeps both sides so neither is lost.
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "binary" | "unknown";
};

export type DependencyRegionOmission = {
  path: string;
  reason: "unsupportedLanguage" | "notIndexed" | "graphUnavailable" | "scanIncomplete";
};

export type DependencyRegion = {
  changedPaths: string[];
  dependencyPaths: string[];
  omissions: DependencyRegionOmission[];
};

export type DependencyEdgeReader = {
  dependenciesOf: (relativePath: string) => Promise<string[]>;
  dependentsOf: (relativePath: string) => Promise<{ paths: string[]; complete: boolean }>;
};

const sortUnique = (values: Iterable<string>): string[] =>
  Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));

// A rename touches two paths; both stay in scope so neither side is silently dropped.
const pathsOf = (change: ChangedPath): string[] =>
  change.previousPath === undefined ? [change.path] : [change.path, change.previousPath];

const seedable = (change: ChangedPath): boolean =>
  change.status !== "binary" && change.status !== "deleted";

/**
 * Derives the bounded region a delta review should read: the changed paths themselves, plus
 * the direct dependencies and direct dependents of the supported TypeScript/JavaScript paths
 * among them.
 *
 * The region is one hop, never transitive. Nothing is guessed: an unsupported language, a
 * binary file, a path the index does not carry, or a scan that ran out of budget is recorded
 * as an omission rather than resolved into edges that were never read. Changed paths survive
 * every failure, so a review whose graph is unavailable still reviews exactly what changed.
 */
export const deriveDependencyRegion = async (input: {
  changed: readonly ChangedPath[];
  reader?: DependencyEdgeReader;
}): Promise<DependencyRegion> => {
  const changedPaths = sortUnique(input.changed.flatMap(pathsOf));
  const changedSet = new Set(changedPaths);
  const omissions: DependencyRegionOmission[] = [];
  const dependencyPaths = new Set<string>();

  const seeds = input.changed.filter(seedable).flatMap(pathsOf);
  for (const seed of sortUnique(seeds)) {
    if (!hasDependencyGraph(seed)) {
      omissions.push({ path: seed, reason: "unsupportedLanguage" });
      continue;
    }
    if (input.reader === undefined) {
      omissions.push({ path: seed, reason: "graphUnavailable" });
      continue;
    }
    let indexed = true;
    try {
      for (const dependency of await input.reader.dependenciesOf(seed)) {
        if (!changedSet.has(dependency)) dependencyPaths.add(dependency);
      }
    } catch {
      indexed = false;
      omissions.push({ path: seed, reason: "notIndexed" });
    }
    if (!indexed) continue;
    try {
      const dependents = await input.reader.dependentsOf(seed);
      for (const dependent of dependents.paths) {
        if (!changedSet.has(dependent)) dependencyPaths.add(dependent);
      }
      if (!dependents.complete) omissions.push({ path: seed, reason: "scanIncomplete" });
    } catch {
      omissions.push({ path: seed, reason: "notIndexed" });
    }
  }

  return {
    changedPaths,
    dependencyPaths: sortUnique(dependencyPaths),
    omissions: omissions.sort((left, right) =>
      left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason)),
  };
};

export const dependencyRegionStatement = (region: DependencyRegion): string => {
  const omitted = region.omissions.length === 0
    ? "No path was omitted from the dependency region."
    : `${String(region.omissions.length)} path${region.omissions.length === 1 ? " was" : "s were"} omitted from the dependency region: ${region.omissions.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}.`;
  return [
    region.changedPaths.length === 0
      ? "No changed path was recorded."
      : `${String(region.changedPaths.length)} changed path${region.changedPaths.length === 1 ? "" : "s"}: ${region.changedPaths.join(", ")}.`,
    region.dependencyPaths.length === 0
      ? "No affected dependency path was included."
      : `${String(region.dependencyPaths.length)} affected dependency path${region.dependencyPaths.length === 1 ? "" : "s"}: ${region.dependencyPaths.join(", ")}.`,
    omitted,
  ].join(" ");
};
