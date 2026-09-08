import * as path from "node:path";
const sanitizeExecutablePath = (value: string | undefined, workingDirectory: string): string | undefined => {
  if (!value) return undefined;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const root = path.resolve(workingDirectory);
  const entries = value.split(delimiter).filter((entry) => {
    const effective = process.platform === "win32" && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (!effective || !path.isAbsolute(effective)) return false;
    const resolved = path.resolve(effective);
    const relative = path.relative(root, resolved);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
  return entries.length > 0 ? entries.join(delimiter) : undefined;
};

const sanitizeEnvironmentPath = (environment: NodeJS.ProcessEnv, workingDirectory: string): NodeJS.ProcessEnv => {
  const pathKeys = Object.keys(environment).sort().filter((key) =>
    process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH",
  );
  const pathValue = pathKeys.map((key) => environment[key]).find((value) => value !== undefined);
  for (const key of pathKeys) delete environment[key];
  const sanitized = sanitizeExecutablePath(pathValue, workingDirectory);
  if (sanitized !== undefined) environment.PATH = sanitized;
  else if (process.platform === "win32") environment.PATH = "";
  return environment;
};

export const safeProcessEnvironment = (
  workingDirectory: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const allowed = new Set([
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "NO_COLOR",
  ]);
  const environment: NodeJS.ProcessEnv = { PWD: workingDirectory };
  Object.entries(process.env).forEach(([key, value]) => {
    if (value !== undefined && (allowed.has(key) || key.startsWith("LC_"))) {
      environment[key] = value;
    }
  });
  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined) {
      environment[key] = value;
    }
  });
  return environment;
};

export const gitProcessEnvironment = (
  workingDirectory: string,
  base?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => ({
  ...sanitizeEnvironmentPath({ ...(base ?? safeProcessEnvironment(workingDirectory)) }, workingDirectory),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
});

export const providerProcessEnvironment = (
  workingDirectory: string,
  additionalVariables: string[] = [],
): NodeJS.ProcessEnv => {
  const names = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "USERNAME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    ...additionalVariables.filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)),
  ]);
  const extra: NodeJS.ProcessEnv = {};
  names.forEach((name) => {
    const value = process.env[name];
    if (value !== undefined) {
      extra[name] = value;
    }
  });
  return safeProcessEnvironment(workingDirectory, extra);
};

export type ProviderEnvironmentProfile = {
  adapterType: string;
  variables?: readonly string[];
  credential?: { sourceVariable: string; targetVariable: string };
  values?: Readonly<Record<string, string>>;
};

const VARIABLE_OWNERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^ANTHROPIC_/u, "claude-code"],
  [/^CLAUDE_/u, "claude-code"],
  [/^OPENAI_/u, "codex-app-server"],
  [/^CODEX_/u, "codex-app-server"],
  [/^ZAI_/u, "zai-glm"],
  [/^ZHIPUAI_/u, "zai-glm"],
  [/^GLM_/u, "zai-glm"],
];

export const providerOwnsVariable = (adapterType: string, name: string): boolean => {
  const owner = VARIABLE_OWNERS.find(([pattern]) => pattern.test(name));
  return owner === undefined || owner[1] === adapterType;
};

const validName = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);

export const providerScopedEnvironment = (input: {
  adapterType: string;
  workingDirectory: string;
  sharedVariables?: readonly string[];
  profile?: ProviderEnvironmentProfile;
}): NodeJS.ProcessEnv => {
  const shared = (input.sharedVariables ?? [])
    .filter(validName)
    .filter((name) => providerOwnsVariable(input.adapterType, name));
  const scoped = (input.profile?.variables ?? []).filter(validName);
  const environment = providerProcessEnvironment(input.workingDirectory, [...shared, ...scoped]);
  const credential = input.profile?.credential;
  if (credential !== undefined && validName(credential.targetVariable)) {
    const value = validName(credential.sourceVariable)
      ? process.env[credential.sourceVariable]
      : undefined;
    if (value === undefined || value.length === 0) delete environment[credential.targetVariable];
    else environment[credential.targetVariable] = value;
  }
  Object.entries(input.profile?.values ?? {}).forEach(([name, value]) => {
    if (!validName(name)) return;
    if (value.length === 0) delete environment[name];
    else environment[name] = value;
  });
  return environment;
};

export const configuredProcessEnvironment = (
  workingDirectory: string,
  additionalVariables: string[] = [],
): NodeJS.ProcessEnv => {
  const extra: NodeJS.ProcessEnv = {};
  additionalVariables
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    .forEach((name) => {
      const value = process.env[name];
      if (value !== undefined) {
        extra[name] = value;
      }
    });
  return sanitizeEnvironmentPath(safeProcessEnvironment(workingDirectory, extra), workingDirectory);
};
