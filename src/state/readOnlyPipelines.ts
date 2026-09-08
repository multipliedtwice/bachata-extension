import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { validatePipelineDefinition } from "../pipeline/schema";
import type { PipelineDefinition } from "../pipeline/types";

export type ReadOnlyPipeline = {
  definition: PipelineDefinition;
  source: "preset" | "workspace";
  filePath: string;
};

const readPipelineDirectory = async (
  directory: string,
  source: ReadOnlyPipeline["source"],
): Promise<ReadOnlyPipeline[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  const pipelines: ReadOnlyPipeline[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const validated = validatePipelineDefinition(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      if (validated.success) pipelines.push({ definition: validated.data, source, filePath });
    } catch {
      // A pipeline file a reader cannot parse is one the writer will report; a read-only
      // window lists the ones it can read rather than refusing to list any.
    }
  }
  return pipelines;
};

/**
 * The pipelines a read-only window can explain: the shipped presets plus the workspace's own
 * catalog, read from disk. Nothing is written, no lock is taken, and no adapter is probed —
 * explaining a pipeline never needs a provider.
 */
export const readOnlyPipelines = async (input: {
  extensionDirectory: string;
  workspaceRoots: readonly string[];
}): Promise<ReadOnlyPipeline[]> => {
  const presets = await readPipelineDirectory(
    path.join(input.extensionDirectory, "presets"),
    "preset",
  );
  const workspace = (await Promise.all(input.workspaceRoots.map((root) =>
    readPipelineDirectory(path.join(root, ".bachata", "pipelines"), "workspace"))))
    .flat();
  const byId = new Map<string, ReadOnlyPipeline>();
  [...presets, ...workspace].forEach((pipeline) => {
    // A workspace pipeline shadows a preset of the same id, exactly as the writer resolves it.
    byId.set(pipeline.definition.id, pipeline);
  });
  return [...byId.values()].sort((left, right) =>
    left.definition.name.localeCompare(right.definition.name));
};
