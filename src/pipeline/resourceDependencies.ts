import type { ResourceDependency } from "./types";

export type ResourceAvailability = {
  id: string;
  available: boolean;
  version?: string;
  configurationDigest?: string;
  detail?: string;
  // The repository's resource declaration could not be read. This is a broken configuration,
  // not an absent resource, so it refuses regardless of whether the dependency was optional.
  configurationError?: string;
};

export type ResourceDependencyStatus = {
  dependency: ResourceDependency;
  available: boolean;
  reproducible: boolean;
  refusal?: string;
  observedVersion?: string;
  observedConfigurationDigest?: string;
};

export type ResourceDependencyPreflight = {
  statuses: ResourceDependencyStatus[];
  refusals: string[];
};

const describe = (dependency: ResourceDependency): string =>
  `${dependency.kind} ${dependency.name}`;

/**
 * Reports whether each declared dependency is present, and whether the version and
 * configuration that answered is the one the pipeline named. A required dependency that is
 * absent or answers with a different fingerprint refuses the run before it starts; an
 * optional one is reported and does not.
 */
export const preflightResourceDependencies = (
  dependencies: readonly ResourceDependency[],
  observed: readonly ResourceAvailability[],
): ResourceDependencyPreflight => {
  const byId = new Map(observed.map((entry) => [entry.id, entry]));
  const statuses = dependencies.map((dependency) => {
    const match = byId.get(dependency.id);
    const available = match?.available === true;
    const versionMismatch = dependency.version !== undefined &&
      match?.version !== undefined &&
      dependency.version !== match.version;
    const digestMismatch = dependency.configurationDigest !== undefined &&
      match?.configurationDigest !== undefined &&
      dependency.configurationDigest !== match.configurationDigest;
    const unverifiedFingerprint =
      (dependency.version !== undefined && match?.version === undefined) ||
      (dependency.configurationDigest !== undefined && match?.configurationDigest === undefined);
    // A declared fingerprint that cannot be observed is not a pass. For a required
    // dependency it refuses, because the workflow asked for an exact resource and Bachata
    // cannot confirm it is the one that answered.
    const refusal = !available
      ? `${describe(dependency)} is declared${dependency.required ? " and required" : ""} but was not available${match?.detail ? `: ${match.detail}` : ""}`
      : versionMismatch
        ? `${describe(dependency)} answered version ${String(match?.version)}, and this workflow declares ${String(dependency.version)}`
        : digestMismatch
          ? `${describe(dependency)} answered a different configuration than this workflow declares`
          : unverifiedFingerprint
            ? `${describe(dependency)} declares an exact ${dependency.version !== undefined && match?.version === undefined ? "version" : "configuration"} that this provider did not report, so it cannot be confirmed`
            : undefined;
    return {
      dependency,
      available,
      // Reproducible means the exact declared identity answered. An available resource whose
      // version or configuration could not be confirmed is usable, not reproducible.
      reproducible: available && refusal === undefined && !unverifiedFingerprint,
      ...(refusal === undefined ? {} : { refusal }),
      ...(match?.version === undefined ? {} : { observedVersion: match.version }),
      ...(match?.configurationDigest === undefined
        ? {}
        : { observedConfigurationDigest: match.configurationDigest }),
    };
  });
  const configurationErrors = Array.from(new Set(
    observed
      .map((entry) => entry.configurationError)
      .filter((error): error is string => error !== undefined),
  ));
  return {
    statuses,
    refusals: [
      ...configurationErrors,
      ...statuses
        .filter((status) => status.dependency.required && status.refusal !== undefined)
        .map((status) => status.refusal as string),
    ],
  };
};

export const resourceDependencyProvenance = (
  statuses: readonly ResourceDependencyStatus[],
): Array<{
  id: string;
  kind: ResourceDependency["kind"];
  name: string;
  reproducible: boolean;
  version?: string;
  configurationDigest?: string;
}> => statuses.map((status) => ({
  id: status.dependency.id,
  kind: status.dependency.kind,
  name: status.dependency.name,
  reproducible: status.reproducible,
  ...(status.observedVersion === undefined ? {} : { version: status.observedVersion }),
  ...(status.observedConfigurationDigest === undefined
    ? {}
    : { configurationDigest: status.observedConfigurationDigest }),
}));

export const roleMayUseDependency = (
  dependency: ResourceDependency,
  roleOrAgentId: string,
): boolean =>
  dependency.allowedRoles === undefined || dependency.allowedRoles.includes(roleOrAgentId);
