import { createHash } from "node:crypto";

import { JsonValue } from "../adapters/types";
import { canonicalJson } from "./output";
import { validatePipelineDefinition } from "./schema";
import { PipelineDefinition } from "./types";
import { byCodeUnit } from "../security/ordinal";

export type PipelineDependencySnapshot = {
  version: 1;
  definition: PipelineDefinition;
  hash: string;
  scopeKey: string;
  scopeRoot?: string;
};

export type PipelineSnapshot = PipelineDependencySnapshot & {
  dependencies?: Record<string, PipelineDependencySnapshot>;
  bundleHash?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const definitionJson = (definition: PipelineDefinition): JsonValue =>
  JSON.parse(JSON.stringify(definition)) as JsonValue;

const dependencySnapshotJson = (
  snapshot: PipelineDependencySnapshot,
): JsonValue => ({
  version: snapshot.version,
  definition: definitionJson(snapshot.definition),
  hash: snapshot.hash,
  scopeKey: snapshot.scopeKey,
  ...(snapshot.scopeRoot ? { scopeRoot: snapshot.scopeRoot } : {}),
});

const sortedDependencies = (
  dependencies: Record<string, PipelineDependencySnapshot>,
): Record<string, PipelineDependencySnapshot> =>
  Object.fromEntries(
    Object.entries(dependencies)
      .sort(([left], [right]) => byCodeUnit(left, right))
      .map(([id, snapshot]) => [id, structuredClone(snapshot)]),
  );

export const pipelineDefinitionHash = (definition: PipelineDefinition): string =>
  createHash("sha256").update(canonicalJson(definitionJson(definition))).digest("hex");

export const pipelineSnapshotBundleHash = (
  root: PipelineDependencySnapshot,
  dependencies: Record<string, PipelineDependencySnapshot>,
): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        root: dependencySnapshotJson(root),
        dependencies: Object.fromEntries(
          Object.entries(sortedDependencies(dependencies)).map(([id, snapshot]) => [
            id,
            dependencySnapshotJson(snapshot),
          ]),
        ),
      }),
    )
    .digest("hex");

export const createPipelineSnapshot = (
  definition: PipelineDefinition,
  scopeKey: string,
  scopeRoot?: string,
): PipelineSnapshot => ({
  version: 1,
  definition: structuredClone(definition),
  hash: pipelineDefinitionHash(definition),
  scopeKey,
  ...(scopeRoot ? { scopeRoot } : {}),
});

export const createPipelineExecutionSnapshot = (
  root: PipelineDependencySnapshot,
  dependencies: Record<string, PipelineDependencySnapshot>,
): PipelineSnapshot => {
  const normalized = sortedDependencies(dependencies);
  return {
    ...structuredClone(root),
    dependencies: normalized,
    bundleHash: pipelineSnapshotBundleHash(root, normalized),
  };
};

export const pipelineSnapshotRootsEqual = (
  left: PipelineDependencySnapshot | undefined,
  right: PipelineDependencySnapshot | undefined,
): boolean =>
  Boolean(
    left &&
    right &&
    left.version === right.version &&
    left.definition.id === right.definition.id &&
    left.hash === right.hash &&
    left.scopeKey === right.scopeKey &&
    left.scopeRoot === right.scopeRoot,
  );

export const pipelineSnapshotsEqual = (
  left: PipelineSnapshot | undefined,
  right: PipelineSnapshot | undefined,
): boolean =>
  Boolean(
    pipelineSnapshotRootsEqual(left, right) &&
    left?.bundleHash === right?.bundleHash &&
    Boolean(left?.dependencies) === Boolean(right?.dependencies),
  );

const parseDependencySnapshot = (
  value: unknown,
): PipelineDependencySnapshot | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.hash) ||
    typeof value.scopeKey !== "string" ||
    value.scopeKey.length === 0 ||
    (value.scopeRoot !== undefined && typeof value.scopeRoot !== "string") ||
    value.dependencies !== undefined ||
    value.bundleHash !== undefined
  ) {
    return undefined;
  }
  const validated = validatePipelineDefinition(value.definition);
  if (!validated.success || pipelineDefinitionHash(validated.data) !== value.hash) {
    return undefined;
  }
  return {
    version: 1,
    definition: validated.data,
    hash: value.hash,
    scopeKey: value.scopeKey,
    ...(typeof value.scopeRoot === "string" && value.scopeRoot.length > 0
      ? { scopeRoot: value.scopeRoot }
      : {}),
  };
};

export const parsePipelineSnapshot = (value: unknown): PipelineSnapshot | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const root = parseDependencySnapshot({
    version: value.version,
    definition: value.definition,
    hash: value.hash,
    scopeKey: value.scopeKey,
    ...(value.scopeRoot !== undefined ? { scopeRoot: value.scopeRoot } : {}),
  });
  if (!root) {
    return undefined;
  }
  if (value.dependencies === undefined && value.bundleHash === undefined) {
    return root;
  }
  if (
    !isRecord(value.dependencies) ||
    typeof value.bundleHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.bundleHash)
  ) {
    return undefined;
  }
  const dependencies: Record<string, PipelineDependencySnapshot> = {};
  for (const [id, candidate] of Object.entries(value.dependencies)) {
    const parsed = parseDependencySnapshot(candidate);
    if (!parsed || parsed.definition.id !== id) {
      return undefined;
    }
    dependencies[id] = parsed;
  }
  const normalized = sortedDependencies(dependencies);
  if (pipelineSnapshotBundleHash(root, normalized) !== value.bundleHash) {
    return undefined;
  }
  return {
    ...root,
    dependencies: normalized,
    bundleHash: value.bundleHash,
  };
};
