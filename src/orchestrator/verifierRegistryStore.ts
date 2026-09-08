import * as path from "node:path";
import { readFile } from "node:fs/promises";

import { parseVerifierRegistry, VERIFIER_REGISTRY_PATH } from "./verifierRegistry";
import type { VerifierRegistry } from "./verifierRegistry";

export type VerifierRegistryLoad = {
  present: boolean;
  registry?: VerifierRegistry;
  errors: string[];
};

export const loadVerifierRegistry = async (
  repositoryRoot: string,
): Promise<VerifierRegistryLoad> => {
  let source: string;
  try {
    source = await readFile(path.join(repositoryRoot, ...VERIFIER_REGISTRY_PATH.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, errors: [] };
    }
    return {
      present: true,
      errors: [`${VERIFIER_REGISTRY_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (source.length > 262_144) {
    return { present: true, errors: [`${VERIFIER_REGISTRY_PATH} is larger than 256 KiB`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return {
      present: true,
      errors: [`${VERIFIER_REGISTRY_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = parseVerifierRegistry(value);
  return parsed.registry
    ? { present: true, registry: parsed.registry, errors: [] }
    : { present: true, errors: parsed.errors };
};
