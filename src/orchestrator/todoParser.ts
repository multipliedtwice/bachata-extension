import { createHash } from "node:crypto";
import * as path from "node:path";

import { isDeclarableVerificationCommand } from "./verificationPolicy";
import { TodoDocument, TodoTaskSpec } from "./types";

export const todoCheckboxPattern = /^(\s*)[-*+]\s+\[([ xX])\]\s+(?:\[([A-Za-z0-9._-]+)\]\s+)?(.+?)\s*$/u;
const checkboxPattern = todoCheckboxPattern;
export const todoMetadataPattern = /^\s*[-*+]\s+([^:\r\n]+):\s*(.*?)\s*$/u;
const metadataPattern = todoMetadataPattern;
const unbulletedMetadataPattern = /^\s*([^:\r\n]+):\s*(.*?)\s*$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const integerPattern = /^-?\d+$/u;
const resourceNamePattern = /^[^\s,\0]+$/u;

export const metadataAliases = new Map<string, { canonical: string; label: string; repeatable?: boolean }>([
  ["dependson", { canonical: "dependencies", label: "Depends on" }],
  ["dependencies", { canonical: "dependencies", label: "Dependencies" }],
  ["pipeline", { canonical: "pipeline", label: "Pipeline" }],
  ["paths", { canonical: "paths", label: "Paths" }],
  ["scope", { canonical: "paths", label: "Scope" }],
  ["verify", { canonical: "checks", label: "Verify", repeatable: true }],
  ["check", { canonical: "checks", label: "Check", repeatable: true }],
  ["resources", { canonical: "checkResources", label: "Resources" }],
  ["checkresources", { canonical: "checkResources", label: "Check Resources" }],
  ["verifyfinal", { canonical: "finalChecks", label: "Verify Final", repeatable: true }],
  ["finalverify", { canonical: "finalChecks", label: "Final Verify", repeatable: true }],
  ["finalcheck", { canonical: "finalChecks", label: "Final Check", repeatable: true }],
  ["finalresources", { canonical: "finalCheckResources", label: "Final Resources" }],
  ["finalcheckresources", { canonical: "finalCheckResources", label: "Final Check Resources" }],
  ["priority", { canonical: "priority", label: "Priority" }],
  ["retries", { canonical: "retries", label: "Retries" }],
  ["description", { canonical: "description", label: "Description", repeatable: true }],
  ["notes", { canonical: "description", label: "Notes", repeatable: true }],
  ["note", { canonical: "description", label: "Note", repeatable: true }],
]);

export const normalizeRepositoryPath = (value: string, taskId: string): string => {
  const directoryHint = /[\\/]$/u.test(value.trim());
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//u, "");
  if (
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid repository path for task ${taskId}: ${value}`);
  }
  const withoutTrailingSlash = normalized === "." ? "" : normalized.replace(/\/$/u, "");
  return directoryHint && withoutTrailingSlash ? `${withoutTrailingSlash}/` : withoutTrailingSlash;
};

export const repositoryPathComparisonKey = (value: string): string => {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//u, "").replace(/\/$/u, "");
  return (normalized === "." ? "" : normalized).toLowerCase();
};

export const normalizeCheckResourceNames = (
  values: string[],
  label = "Check resources",
): string[] => {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const input of values) {
    const value = input.trim();
    if (/^global:/iu.test(value) && !value.startsWith("global:")) {
      throw new Error(`${label} must use the exact lowercase global: prefix: ${input}`);
    }
    if (
      !value ||
      value.length > 256 ||
      !resourceNamePattern.test(value) ||
      value === "global:"
    ) {
      throw new Error(`${label} contains an invalid resource name: ${input || "<empty>"}`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
};

const compact = (value: string): string => value.replace(/\s+/gu, " ").trim();

const generatedId = (line: number, title: string): string => {
  const hash = createHash("sha256").update(`${String(line)}\0${title}`).digest("hex").slice(0, 10);
  return `TODO-${String(line)}-${hash}`;
};

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  // Every read below is inside the row it just built, so the fallbacks are unreachable; they
  // exist because the compiler cannot see the invariant that the row is `right.length + 1`
  // long by construction.
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        (current[rightIndex] ?? 0) + 1,
        (previous[rightIndex + 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
};

export const closestMetadataLabel = (key: string): string | undefined => {
  let closest: { label: string; distance: number } | undefined;
  for (const [alias, metadata] of metadataAliases) {
    const distance = editDistance(key, alias);
    if (!closest || distance < closest.distance) {
      closest = { label: metadata.label, distance };
    }
  }
  return closest && closest.distance <= 3 ? closest.label : undefined;
};

export const validateTodoTasks = (tasks: TodoTaskSpec[]): void => {
  const ids = new Set<string>();
  tasks.forEach((task) => {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate TODO task id: ${task.id}`);
    }
    ids.add(task.id);
  });
  tasks.forEach((task) => {
    task.dependsOn.forEach((dependency) => {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`Task ${task.id} cannot depend on itself`);
      }
    });
  });

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`TODO dependency cycle contains ${id}`);
    }
    visiting.add(id);
    byId.get(id)?.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
};

export const parseTodoDocument = (
  filePath: string,
  source: string,
  defaults: {
    pipelineId: string;
    retries: number;
    requirePaths?: boolean;
    requireControllerVerification?: boolean;
  },
): TodoDocument => {
  const resolvedFilePath = path.resolve(filePath);
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const tasks: TodoTaskSpec[] = [];
  let current: TodoTaskSpec | undefined;
  let currentIndent = 0;
  let metadataLines = new Map<string, number>();
  let checkMode: "none" | "commands" | undefined;
  let finalCheckMode: "none" | "commands" | undefined;

  const finalizeCurrent = (): void => {
    if (!current) {
      return;
    }
    if (defaults.requirePaths === true && !current.completed && !metadataLines.has("paths")) {
      throw new Error(
        `Invalid TODO metadata at ${resolvedFilePath}:${String(current.line)} for task ${current.id}: Paths is required; use Paths: . only for an explicit whole-workspace task`,
      );
    }
    if (defaults.requireControllerVerification === true && !current.completed) {
      const unsupported = [...current.checks, ...(current.finalChecks ?? [])]
        .filter((command) => !isDeclarableVerificationCommand(command));
      if (unsupported.length > 0) {
        throw new Error(
          `Invalid TODO metadata at ${resolvedFilePath}:${String(current.line)} for task ${current.id}: Verify commands must be bachata:workspace-integrity, bachata:project-checks, or bachata:verifier:<id> declared in .bachata/verifiers.json. An unattended run executes the first two; a declared descriptor runs only under one recorded workspace approval during an explicit Improve run.`,
        );
      }
    }
    const checkResourceLine = metadataLines.get("checkResources");
    if (
      checkResourceLine !== undefined &&
      (current.checkResources?.length ?? 0) > 0 &&
      (!current.checksDeclared || current.checks.length === 0)
    ) {
      throw new Error(
        `Invalid TODO metadata at ${resolvedFilePath}:${String(checkResourceLine)} for task ${current.id}: Resources requires at least one Verify command and cannot be combined with Verify: none`,
      );
    }
    const finalResourceLine = metadataLines.get("finalCheckResources");
    if (
      finalResourceLine !== undefined &&
      (current.finalCheckResources?.length ?? 0) > 0 &&
      (!current.finalChecksDeclared || (current.finalChecks?.length ?? 0) === 0)
    ) {
      throw new Error(
        `Invalid TODO metadata at ${resolvedFilePath}:${String(finalResourceLine)} for task ${current.id}: Final Resources requires at least one Verify Final command and cannot be combined with Verify Final: none`,
      );
    }
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const checkbox = line.match(checkboxPattern);
    if (checkbox) {
      finalizeCurrent();
      const title = compact(checkbox[4] ?? "");
      if (!title) {
        throw new Error(`TODO task at ${resolvedFilePath}:${String(lineNumber)} has no title`);
      }
      const explicit = checkbox[3]?.trim();
      if (explicit && !idPattern.test(explicit)) {
        throw new Error(`Invalid TODO task id at ${resolvedFilePath}:${String(lineNumber)}: ${explicit}`);
      }
      currentIndent = (checkbox[1] ?? "").length;
      current = {
        id: explicit ?? generatedId(lineNumber, title),
        title,
        description: "",
        completed: (checkbox[2] ?? "").toLowerCase() === "x",
        line: lineNumber,
        explicitId: Boolean(explicit),
        dependsOn: [],
        pipelineId: defaults.pipelineId,
        paths: [],
        checks: [],
        checksDeclared: false,
        checkResources: [],
        finalChecks: [],
        finalChecksDeclared: false,
        finalCheckResources: [],
        priority: 0,
        retries: defaults.retries,
      };
      metadataLines = new Map();
      checkMode = undefined;
      finalCheckMode = undefined;
      tasks.push(current);
      return;
    }
    if (!current || !line.trim()) {
      return;
    }
    const indentation = line.length - line.trimStart().length;
    if (indentation <= currentIndent) {
      finalizeCurrent();
      current = undefined;
      metadataLines = new Map();
      checkMode = undefined;
      finalCheckMode = undefined;
      return;
    }
    const fail = (message: string): never => {
      throw new Error(`Invalid TODO metadata at ${resolvedFilePath}:${String(lineNumber)} for task ${current?.id ?? "unknown"}: ${message}`);
    };
    const commaList = (value: string, label: string): string[] => {
      if (!value.trim()) {
        return fail(`${label} cannot be empty`);
      }
      const parts = value.split(",").map((item) => item.trim());
      if (parts.some((item) => !item)) {
        return fail(`${label} contains an empty comma-separated value`);
      }
      return Array.from(new Set(parts));
    };
    const strictInteger = (value: string, label: string, minimum: number, maximum: number): number => {
      if (!integerPattern.test(value)) {
        return fail(`${label} must be a complete integer`);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        return fail(`${label} must be between ${String(minimum)} and ${String(maximum)}`);
      }
      return parsed;
    };
    const metadata = line.match(metadataPattern);
    if (!metadata) {
      const unbulletedMetadata = line.match(unbulletedMetadataPattern);
      if (unbulletedMetadata) {
        const rawKey = (unbulletedMetadata[1] ?? "").trim();
        const normalizedKey = rawKey.replace(/\s+/gu, "").toLowerCase();
        const definition = metadataAliases.get(normalizedKey);
        if (definition) {
          return fail(`${definition.label} must be a nested list item beginning with "- "`);
        }
      }
      current.description = [current.description, line.trim()].filter(Boolean).join("\n");
      return;
    }
    const rawKey = (metadata[1] ?? "").trim();
    const normalizedKey = rawKey.replace(/\s+/gu, "").toLowerCase();
    const definition = metadataAliases.get(normalizedKey);
    if (!definition) {
      const suggestion = closestMetadataLabel(normalizedKey);
      return fail(`Unknown key "${rawKey}"${suggestion ? `. Did you mean "${suggestion}"?` : ""}`);
    }
    const previousLine = metadataLines.get(definition.canonical);
    if (previousLine !== undefined && !definition.repeatable) {
      return fail(`${definition.label} duplicates metadata declared on line ${String(previousLine)}`);
    }
    metadataLines.set(definition.canonical, previousLine ?? lineNumber);
    const value = (metadata[2] ?? "").trim();

    if (definition.canonical === "dependencies") {
      current.dependsOn = commaList(value, definition.label);
    } else if (definition.canonical === "pipeline") {
      if (!idPattern.test(value)) {
        return fail(`Invalid pipeline id: ${value || "<empty>"}`);
      }
      current.pipelineId = value;
    } else if (definition.canonical === "paths") {
      try {
        current.paths = commaList(value, definition.label)
          .map((item) => normalizeRepositoryPath(item, current?.id ?? "unknown"));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    } else if (definition.canonical === "checks") {
      current.checksDeclared = true;
      if (!value) {
        return fail(`${definition.label} cannot be empty`);
      }
      if (value.toLowerCase() === "none") {
        if (checkMode !== undefined) {
          return fail(`${definition.label}: none conflicts with another verification declaration`);
        }
        checkMode = "none";
      } else {
        if (checkMode === "none") {
          return fail(`${definition.label} conflicts with an earlier none declaration`);
        }
        checkMode = "commands";
        if (current.checks.includes(value)) {
          return fail(`${definition.label} duplicates an existing command`);
        }
        current.checks.push(value);
      }
    } else if (definition.canonical === "checkResources") {
      try {
        current.checkResources = normalizeCheckResourceNames(
          commaList(value, definition.label),
          definition.label,
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    } else if (definition.canonical === "finalChecks") {
      current.finalChecksDeclared = true;
      if (!value) {
        return fail(`${definition.label} cannot be empty`);
      }
      if (value.toLowerCase() === "none") {
        if (finalCheckMode !== undefined) {
          return fail(`${definition.label}: none conflicts with another final verification declaration`);
        }
        finalCheckMode = "none";
      } else {
        if (finalCheckMode === "none") {
          return fail(`${definition.label} conflicts with an earlier none declaration`);
        }
        finalCheckMode = "commands";
        if (current.finalChecks?.includes(value)) {
          return fail(`${definition.label} duplicates an existing command`);
        }
        current.finalChecks?.push(value);
      }
    } else if (definition.canonical === "finalCheckResources") {
      try {
        current.finalCheckResources = normalizeCheckResourceNames(
          commaList(value, definition.label),
          definition.label,
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    } else if (definition.canonical === "priority") {
      current.priority = strictInteger(value, definition.label, -1000, 1000);
    } else if (definition.canonical === "retries") {
      current.retries = strictInteger(value, definition.label, 0, 10);
    } else if (definition.canonical === "description") {
      if (!value) {
        return fail(`${definition.label} cannot be empty`);
      }
      current.description = [current.description, value].filter(Boolean).join("\n");
    }
  });

  finalizeCurrent();
  validateTodoTasks(tasks);
  return {
    filePath: resolvedFilePath,
    source,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    tasks,
  };
};

export const markTodoTaskCompleted = (
  source: string,
  task: TodoTaskSpec,
): string => {
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const explicit = task.explicitId ? `[${task.id}]` : undefined;
  const index = lines.findIndex((line, lineIndex) => {
    const match = line.match(checkboxPattern);
    if (!match) {
      return false;
    }
    if (explicit) {
      return match[3] === task.id;
    }
    return lineIndex + 1 === task.line && compact(match[4] ?? "") === task.title;
  });
  if (index < 0) {
    throw new Error(`Cannot find TODO task ${task.id} to mark completed`);
  }
  lines[index] = (lines[index] ?? "").replace(/\[[ xX]\]/u, "[x]");
  return lines.join(lineEnding);
};
