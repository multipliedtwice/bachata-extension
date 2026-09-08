export type CommitMode = "never" | "allow";

export type TaskPolicy = {
  commitMode: CommitMode;
  allowedPaths: string[];
  restrictedPaths: string[];
  readOnlyRoles: string[];
  requireVerification: boolean;
};

const NO_COMMIT_PATTERN = /\b(?:do\s+not|don't|never|without)\s+(?:create\s+(?:a\s+)?)?(?:git\s+)?commit\b|\bno[-\s]?commit\b/i;

const normalizeStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];

const preservePathArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];

const findCommitMode = (value: unknown, seen = new Set<unknown>()): CommitMode | undefined => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "never" || normalized === "no-commit" || normalized === "no_commit") {
      return "never";
    }
    if (normalized === "allow" || normalized === "commit") {
      return "allow";
    }
    return NO_COMMIT_PATTERN.test(value) ? "never" : undefined;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["commitMode", "commit_mode", "commitPolicy", "commit_policy"]) {
    const direct = findCommitMode(record[key], seen);
    if (direct) {
      return direct;
    }
  }
  for (const key of ["taskPolicy", "policy", "pipeline", "task", "request", "userPrompt", "prompt", "instructions"]) {
    const nested = findCommitMode(record[key], seen);
    if (nested) {
      return nested;
    }
  }
  return undefined;
};

export const deriveCommitMode = (value?: unknown): CommitMode => findCommitMode(value) ?? "never";

export const createTaskPolicy = (value?: unknown): TaskPolicy => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    commitMode: deriveCommitMode(value),
    allowedPaths: preservePathArray(record.allowedPaths ?? record.allowed_paths),
    restrictedPaths: preservePathArray(record.restrictedPaths ?? record.restricted_paths),
    readOnlyRoles: normalizeStringArray(record.readOnlyRoles ?? record.read_only_roles),
    requireVerification: record.requireVerification !== false,
  };
};

export const isRoleReadOnly = (policy: TaskPolicy | undefined, roleId: string | undefined): boolean => {
  if (!roleId) {
    return false;
  }
  const normalized = roleId.trim().toLowerCase();
  if (normalized === "lead" || normalized.endsWith("-lead") || normalized.includes("review")) {
    return true;
  }
  return Boolean(policy?.readOnlyRoles.some((role) => role.trim().toLowerCase() === normalized));
};

export const shouldCreateCommit = (value?: unknown): boolean => deriveCommitMode(value) === "allow";
