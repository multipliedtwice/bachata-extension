import { parsePorcelainDirtyPaths } from "./gitStatus";

/**
 * EX-3. What a Git probe means, decided apart from running Git.
 *
 * Readiness asks Git two things — its version and its status — and each can answer, refuse, or
 * be a version Bachata will not drive. Four outcomes, and the difference between them is what the
 * reader is told: an unusable repository is not an unavailable Git, and a Git that is too old is
 * a requirement rather than an error. That distinction lived beside the two `checkCommand` calls
 * in the runtime, so it could only be reached by running Git.
 *
 * `dirtyPaths` is present whenever a status was read, empty list included: absent means the
 * question was never answered, and a caller must not read that as "nothing is dirty".
 */
export type GitReadiness = {
  available: boolean;
  detail: string;
  clean?: boolean;
  statusDetail?: string;
  dirtyPaths?: string[];
};

export type GitProbeOutcome =
  /** `git --version` did not run. */
  | { outcome: "versionFailed"; error: unknown }
  /** Git ran and is a version this product does not drive. */
  | { outcome: "unsupported"; requirementText: string }
  /** Git ran; `git status` did not, so the root is not a usable repository. */
  | { outcome: "statusFailed"; error: unknown }
  /** Both ran. */
  | { outcome: "status"; version: string; status: string };

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const gitReadinessFrom = (probe: GitProbeOutcome): GitReadiness => {
  if (probe.outcome === "versionFailed") {
    return { available: false, detail: errorText(probe.error) };
  }
  if (probe.outcome === "unsupported") {
    return { available: false, detail: probe.requirementText };
  }
  if (probe.outcome === "statusFailed") {
    return {
      available: false,
      detail: errorText(probe.error),
      statusDetail: "The selected root is not a usable Git repository",
    };
  }
  const clean = probe.status.length === 0;
  return {
    available: true,
    detail: probe.version,
    clean,
    statusDetail: clean ? "Workspace is clean" : "Workspace has uncommitted changes",
    dirtyPaths: parsePorcelainDirtyPaths(probe.status),
  };
};
