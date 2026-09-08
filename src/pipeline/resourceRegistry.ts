import type { ResourceAvailability } from "./resourceDependencies";

export const RESOURCE_REGISTRY_PATH = ".bachata/resources.json";

export type ResourceRegistryEntry = {
  id: string;
  // The identity a dependency declares. An id alone is not identity: a pipeline could keep
  // the id and change what it is asking for.
  kind: string;
  name: string;
  version?: string;
  configurationDigest?: string;
  note?: string;
};

export type ResourceRegistry = {
  version: 1;
  resources: ResourceRegistryEntry[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (
  value: unknown,
  field: string,
  path: string,
  errors: string[],
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path}.${field} must be a non-empty string when present`);
    return undefined;
  }
  return value.trim();
};

/**
 * The repository states which external resources it actually provides. Bachata never introspects
 * a provider's installed servers or skills, because a provider reporting a name is not proof
 * that the named thing is the one a workflow declared. This registry is the human-owned
 * counterpart to a pipeline's declared dependencies, and comparing the two is what makes a
 * dependency reproducible rather than merely present.
 */
export const parseResourceRegistry = (
  value: unknown,
): { registry?: ResourceRegistry; errors: string[] } => {
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: [`${RESOURCE_REGISTRY_PATH} must be a JSON object`] };
  if (value.version !== 1) errors.push(`${RESOURCE_REGISTRY_PATH}.version must be 1`);
  if (!Array.isArray(value.resources)) {
    errors.push(`${RESOURCE_REGISTRY_PATH}.resources must be an array`);
    return { errors };
  }
  const seen = new Set<string>();
  const resources = value.resources.flatMap((entry, index) => {
    const path = `${RESOURCE_REGISTRY_PATH}.resources[${String(index)}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return [];
    }
    Object.keys(entry).forEach((key) => {
      if (!["id", "kind", "name", "version", "configurationDigest", "note"].includes(key)) {
        errors.push(`${path}.${key} is not a known key`);
      }
    });
    const id = optionalString(entry.id, "id", path, errors);
    if (id === undefined) {
      errors.push(`${path}.id is required`);
      return [];
    }
    if (seen.has(id)) {
      errors.push(`${path}.id duplicates resource ${id}`);
      return [];
    }
    seen.add(id);
    const kind = optionalString(entry.kind, "kind", path, errors);
    const name = optionalString(entry.name, "name", path, errors);
    if (kind === undefined) errors.push(`${path}.kind is required`);
    if (name === undefined) errors.push(`${path}.name is required`);
    if (kind === undefined || name === undefined) return [];
    const version = optionalString(entry.version, "version", path, errors);
    const configurationDigest = optionalString(
      entry.configurationDigest,
      "configurationDigest",
      path,
      errors,
    );
    const note = optionalString(entry.note, "note", path, errors);
    return [{
      id,
      kind,
      name,
      ...(version === undefined ? {} : { version }),
      ...(configurationDigest === undefined ? {} : { configurationDigest }),
      ...(note === undefined ? {} : { note }),
    }];
  });
  if (errors.length > 0) return { errors };
  return { registry: { version: 1, resources }, errors: [] };
};

export const resourceAvailabilityFromRegistry = (
  registry: ResourceRegistry | undefined,
  dependencies: readonly { id: string; kind?: string; name?: string }[],
): ResourceAvailability[] => {
  const byId = new Map((registry?.resources ?? []).map((entry) => [entry.id, entry]));
  return dependencies.map((dependency) => {
    const entry = byId.get(dependency.id);
    if (entry === undefined) {
      return {
        id: dependency.id,
        available: false,
        detail: registry === undefined
          ? `${RESOURCE_REGISTRY_PATH} declares no resources for this repository`
          : `${RESOURCE_REGISTRY_PATH} does not declare ${dependency.id}`,
      };
    }
    // Same id, different thing: the declaration and the registry must agree on what it is.
    if (
      (dependency.kind !== undefined && dependency.kind !== entry.kind) ||
      (dependency.name !== undefined && dependency.name !== entry.name)
    ) {
      return {
        id: dependency.id,
        available: false,
        detail: `${RESOURCE_REGISTRY_PATH} declares ${dependency.id} as ${entry.kind} ${entry.name}, and this workflow declares ${String(dependency.kind)} ${String(dependency.name)}`,
      };
    }
    return {
      id: dependency.id,
      available: true,
      ...(entry.version === undefined ? {} : { version: entry.version }),
      ...(entry.configurationDigest === undefined
        ? {}
        : { configurationDigest: entry.configurationDigest }),
      ...(entry.note === undefined ? {} : { detail: entry.note }),
    };
  });
};

export type ResourceRegistryLoad =
  | { status: "absent" }
  | { status: "valid"; registry: ResourceRegistry }
  | { status: "invalid"; errors: string[] };

/**
 * Absent, valid, and invalid are three different answers. A malformed registry is never
 * read as "no resources declared": a repository that tried to declare its resources and got
 * it wrong must refuse the run rather than quietly behave as if it had declared nothing.
 */
export const loadResourceRegistry = async (
  repositoryRoot: string,
  readFile: (path: string) => Promise<string>,
): Promise<ResourceRegistryLoad> => {
  // Only a missing file means "no registry". A registry that exists but cannot be read —
  // permissions, a directory in its place, an I/O error — is a broken declaration, and
  // treating it as absent would let a run proceed on configuration nobody could verify.
  const MISSING = new Set(["ENOENT", "ENOTDIR"]);
  let source: string;
  try {
    source = await readFile(`${repositoryRoot}/${RESOURCE_REGISTRY_PATH}`);
  } catch (error) {
    const code = typeof (error as { code?: unknown } | undefined)?.code === "string"
      ? (error as { code: string }).code
      : undefined;
    if (code !== undefined && MISSING.has(code)) return { status: "absent" };
    return {
      status: "invalid",
      errors: [
        `${RESOURCE_REGISTRY_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`
          .slice(0, 500),
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return {
      status: "invalid",
      errors: [`${RESOURCE_REGISTRY_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = parseResourceRegistry(value);
  return parsed.registry === undefined
    ? { status: "invalid", errors: parsed.errors }
    : { status: "valid", registry: parsed.registry };
};

/**
 * EX-3. What a registry load says about the dependencies a workflow declared.
 *
 * Three loads, three answers. A registry the repository never wrote declares nothing, so each
 * dependency is judged unavailable on its own terms. A registry that exists and parses is compared
 * entry by entry. A registry the repository tried to write and got wrong refuses every dependency,
 * required or not, and says why: reading a broken declaration as "nothing declared" would let a
 * workflow run against resources nobody confirmed.
 *
 * The rule lived inside the conversation manager's runtime-construction closure, where reaching it
 * meant building a manager, a runtime and a repository with a malformed registry in it.
 */
export const resourceAvailabilityForLoad = (
  load: ResourceRegistryLoad,
  dependencies: readonly { id: string; kind?: string; name?: string }[],
): ResourceAvailability[] =>
  load.status === "invalid"
    ? dependencies.map((dependency) => ({
        id: dependency.id,
        available: false,
        configurationError: `${RESOURCE_REGISTRY_PATH} could not be read: ${load.errors.join("; ")}`,
      }))
    : resourceAvailabilityFromRegistry(
        load.status === "valid" ? load.registry : undefined,
        dependencies,
      );
