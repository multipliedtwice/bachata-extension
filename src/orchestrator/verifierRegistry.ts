import { hasTraversalSegment, isAbsoluteLikePath, normalizeRelativeRepositoryPath } from "../readiness/paths";
import { planLooksLikeHumanOnlyE2e } from "../process/humanOnlyE2e";

export const VERIFIER_REGISTRY_PATH = ".bachata/verifiers.json";
export const VERIFIER_COMMAND_PREFIX = "bachata:verifier:";

export type VerifierExpectation = {
  exitCode: number;
  stdoutIncludes?: string;
  stdoutExcludes?: string;
};

export type VerifierDescriptor = {
  id: string;
  description: string;
  executable: string;
  args: string[];
  workingDirectory: string;
  environmentAllowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  expect: VerifierExpectation;
};

export type VerifierRegistry = {
  version: 1;
  verifiers: VerifierDescriptor[];
};

export const verifierCommand = (id: string): string => `${VERIFIER_COMMAND_PREFIX}${id}`;

export const verifierDescriptorId = (command: string): string | undefined =>
  command.startsWith(VERIFIER_COMMAND_PREFIX)
    ? command.slice(VERIFIER_COMMAND_PREFIX.length)
    : undefined;

export const findVerifier = (
  registry: VerifierRegistry | undefined,
  command: string,
): VerifierDescriptor | undefined => {
  const id = verifierDescriptorId(command);
  return id === undefined
    ? undefined
    : registry?.verifiers.find((descriptor) => descriptor.id === id);
};

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const isVerifierId = (value: string | undefined): boolean =>
  value !== undefined && idPattern.test(value);
const environmentPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const executableMetacharacters = /[;&|<>^"%$`\u0000-\u001f]/u;
const argumentMetacharacters = /[&|<>^"%\u0000-\u001f]/u;
const shellWrappers = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  "env", "nohup", "xargs", "eval", "exec", "sudo", "doas", "su", "ssh",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const executableName = (executable: string): string => {
  const segments = executable.replaceAll("\\", "/").split("/");
  return (segments[segments.length - 1] ?? "").toLowerCase();
};

const parseDescriptor = (
  value: unknown,
  index: number,
  errors: string[],
): VerifierDescriptor | undefined => {
  const position = `verifiers[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${position} is not an object`);
    return undefined;
  }
  const allowedKeys = new Set([
    "id", "description", "executable", "args", "workingDirectory",
    "environmentAllowlist", "timeoutMs", "maxOutputBytes", "expect",
  ]);
  Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .forEach((key) => errors.push(`${position} has an unknown key: ${key}`));

  const id = value.id;
  if (typeof id !== "string" || !idPattern.test(id)) {
    errors.push(`${position}.id must match ${String(idPattern)}`);
    return undefined;
  }
  const named = `verifier "${id}"`;
  const before = errors.length;

  const description = value.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push(`${named} needs a description that says what it proves`);
  }
  const executable = value.executable;
  if (typeof executable !== "string" || executable.trim().length === 0) {
    errors.push(`${named} needs an executable`);
  } else if (executableMetacharacters.test(executable)) {
    errors.push(`${named} executable contains shell metacharacters`);
  } else if (shellWrappers.has(executableName(executable))) {
    errors.push(`${named} may not run through a shell or process wrapper: ${executable}`);
  } else if (hasTraversalSegment(executable)) {
    errors.push(`${named} executable may not traverse out of the repository`);
  }
  const rawArgs = value.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.some((entry) => typeof entry !== "string")) {
    errors.push(`${named} args must be an array of strings`);
  } else if (rawArgs.some((entry) => argumentMetacharacters.test(entry as string))) {
    errors.push(`${named} args contain shell metacharacters`);
  } else if (
    typeof executable === "string" &&
    planLooksLikeHumanOnlyE2e(executable, rawArgs as string[])
  ) {
    // Rejected at parse time on the executable and argument vector, never on the id: a
    // descriptor id is free text and carries no evidence of what it runs. Package scripts
    // that only resolve to E2E are caught later, where a working directory exists to read.
    errors.push(`${named} runs human-only E2E verification, which Bachata never executes automatically`);
  }
  const workingDirectory = value.workingDirectory ?? ".";
  if (typeof workingDirectory !== "string") {
    errors.push(`${named} workingDirectory must be a repository-relative path`);
  } else if (isAbsoluteLikePath(workingDirectory) || hasTraversalSegment(workingDirectory)) {
    errors.push(`${named} workingDirectory must stay inside the repository`);
  }
  const environmentAllowlist = value.environmentAllowlist ?? [];
  if (!Array.isArray(environmentAllowlist) ||
    environmentAllowlist.some((entry) => typeof entry !== "string" || !environmentPattern.test(entry))) {
    errors.push(`${named} environmentAllowlist must be UPPER_SNAKE_CASE variable names`);
  }
  const timeoutMs = value.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    errors.push(`${named} timeoutMs must be an integer between 1000 and 3600000`);
  }
  const maxOutputBytes = value.maxOutputBytes ?? 262_144;
  if (typeof maxOutputBytes !== "number" || !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1_024 || maxOutputBytes > 8_388_608) {
    errors.push(`${named} maxOutputBytes must be an integer between 1024 and 8388608`);
  }
  const expect = value.expect ?? { exitCode: 0 };
  let expectation: VerifierExpectation = { exitCode: 0 };
  if (!isRecord(expect)) {
    errors.push(`${named} expect must be an object`);
  } else {
    Object.keys(expect)
      .filter((key) => !["exitCode", "stdoutIncludes", "stdoutExcludes"].includes(key))
      .forEach((key) => errors.push(`${named} expect has an unknown key: ${key}`));
    const exitCode = expect.exitCode ?? 0;
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      errors.push(`${named} expect.exitCode must be an integer between 0 and 255`);
    }
    const includes = expect.stdoutIncludes;
    const excludes = expect.stdoutExcludes;
    if (includes !== undefined && (typeof includes !== "string" || includes.length === 0)) {
      errors.push(`${named} expect.stdoutIncludes must be a non-empty string`);
    }
    if (excludes !== undefined && (typeof excludes !== "string" || excludes.length === 0)) {
      errors.push(`${named} expect.stdoutExcludes must be a non-empty string`);
    }
    expectation = {
      exitCode: typeof exitCode === "number" ? exitCode : 0,
      ...(typeof includes === "string" ? { stdoutIncludes: includes } : {}),
      ...(typeof excludes === "string" ? { stdoutExcludes: excludes } : {}),
    };
  }
  if (errors.length !== before) return undefined;
  return {
    id,
    description: description as string,
    executable: executable as string,
    args: rawArgs as string[],
    workingDirectory: normalizeRelativeRepositoryPath(workingDirectory as string),
    environmentAllowlist: environmentAllowlist as string[],
    timeoutMs: timeoutMs as number,
    maxOutputBytes: maxOutputBytes as number,
    expect: expectation,
  };
};

export const parseVerifierRegistry = (
  value: unknown,
): { registry?: VerifierRegistry; errors: string[] } => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: ["The verifier registry must be a JSON object"] };
  }
  Object.keys(value)
    .filter((key) => key !== "version" && key !== "verifiers")
    .forEach((key) => errors.push(`The verifier registry has an unknown key: ${key}`));
  if (value.version !== 1) {
    errors.push("The verifier registry must declare \"version\": 1");
  }
  if (!Array.isArray(value.verifiers)) {
    errors.push("The verifier registry must declare a \"verifiers\" array");
    return { errors };
  }
  if (value.verifiers.length > 64) {
    errors.push("The verifier registry declares more than 64 verifiers");
    return { errors };
  }
  const descriptors = value.verifiers
    .map((entry, index) => parseDescriptor(entry, index, errors))
    .filter((entry): entry is VerifierDescriptor => entry !== undefined);
  const duplicates = descriptors
    .map((descriptor) => descriptor.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  Array.from(new Set(duplicates)).forEach((id) =>
    errors.push(`The verifier registry declares "${id}" more than once`),
  );
  return errors.length > 0
    ? { errors }
    : { registry: { version: 1, verifiers: descriptors }, errors };
};

/*
 * A truncated read is a failed read. The bound keeps the head of stdout and drops the tail, so
 * a marker a descriptor expects — or forbids — can be in the part that was never retained: an
 * expectation evaluated over a partial stream proves nothing about the stream. What was seen
 * still counts, so a required marker found in the retained head is found; a required marker
 * that is absent, and a forbidden marker that is absent, are undecided and refuse.
 */
export const verifierOutcome = (
  descriptor: VerifierDescriptor,
  execution: { exitCode?: number; stdout: string; stdoutTruncated?: boolean },
): { passed: boolean; reason?: string } => {
  if (execution.exitCode !== descriptor.expect.exitCode) {
    return {
      passed: false,
      reason: `${descriptor.id} exited with ${String(execution.exitCode ?? "no code")}; expected ${String(descriptor.expect.exitCode)}`,
    };
  }
  const truncated = execution.stdoutTruncated === true;
  if (descriptor.expect.stdoutIncludes !== undefined &&
    !execution.stdout.includes(descriptor.expect.stdoutIncludes)) {
    return {
      passed: false,
      reason: truncated
        ? `${descriptor.id} output exceeded its byte bound, so "${descriptor.expect.stdoutIncludes}" could not be looked for`
        : `${descriptor.id} output did not contain "${descriptor.expect.stdoutIncludes}"`,
    };
  }
  if (descriptor.expect.stdoutExcludes !== undefined) {
    if (execution.stdout.includes(descriptor.expect.stdoutExcludes)) {
      return {
        passed: false,
        reason: `${descriptor.id} output contained "${descriptor.expect.stdoutExcludes}"`,
      };
    }
    if (truncated) {
      return {
        passed: false,
        reason: `${descriptor.id} output exceeded its byte bound, so "${descriptor.expect.stdoutExcludes}" could not be ruled out`,
      };
    }
  }
  return { passed: true };
};
