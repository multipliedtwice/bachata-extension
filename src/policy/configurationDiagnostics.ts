import { parseExportPolicy, EXPORT_POLICY_PATH } from "../export/exportPolicy";
import { parseVerifierRegistry, VERIFIER_REGISTRY_PATH } from "../orchestrator/verifierRegistry";
import { parseRepositoryPolicy, REPOSITORY_POLICY_PATH } from "./repositoryPolicy";

export type BachataConfigurationFile =
  | typeof VERIFIER_REGISTRY_PATH
  | typeof REPOSITORY_POLICY_PATH
  | typeof EXPORT_POLICY_PATH;

export const BACHATA_CONFIGURATION_FILES: BachataConfigurationFile[] = [
  VERIFIER_REGISTRY_PATH,
  REPOSITORY_POLICY_PATH,
  EXPORT_POLICY_PATH,
];

export type ConfigurationDiagnostic = { message: string; line: number };

export const bachataConfigurationFile = (
  normalizedPath: string,
): BachataConfigurationFile | undefined =>
  BACHATA_CONFIGURATION_FILES.find((candidate) => normalizedPath.endsWith(candidate));

const parsers: Record<BachataConfigurationFile, (value: unknown) => { errors: string[] }> = {
  [VERIFIER_REGISTRY_PATH]: parseVerifierRegistry,
  [REPOSITORY_POLICY_PATH]: parseRepositoryPolicy,
  [EXPORT_POLICY_PATH]: parseExportPolicy,
};

const capturedTokens = (message: string, pattern: RegExp): string[] =>
  Array.from(message.matchAll(pattern), (match) => match[1])
    .filter((token): token is string => token !== undefined);

const quotedTokens = (message: string): string[] => [
  ...capturedTokens(message, /"([^"]{1,64})"/gu),
  ...capturedTokens(message, /\b([a-z][A-Za-z0-9]{2,40})\b(?= must| declares| is)/gu),
];

export const diagnosticLine = (source: string, message: string): number => {
  const lines = source.split("\n");
  for (const token of quotedTokens(message)) {
    const index = lines.findIndex((line) => line.includes(`"${token}"`));
    if (index >= 0) return index + 1;
  }
  return 1;
};

export const configurationDiagnostics = (
  file: BachataConfigurationFile,
  source: string,
): ConfigurationDiagnostic[] => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return [{
      message: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      line: 1,
    }];
  }
  return parsers[file](value).errors.map((message) => ({
    message,
    line: diagnosticLine(source, message),
  }));
};

export type DeclaredVerifier = { id: string; description: string; command: string };

export const declaredVerifiers = (source: string): DeclaredVerifier[] => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return [];
  }
  const parsed = parseVerifierRegistry(value);
  return (parsed.registry?.verifiers ?? []).map((descriptor) => ({
    id: descriptor.id,
    description: descriptor.description,
    command: `bachata:verifier:${descriptor.id}`,
  }));
};

export const VERIFIER_REGISTRY_TEMPLATE = `${JSON.stringify({
  version: 1,
  verifiers: [
    {
      id: "unit-tests",
      description: "Node test runner over tests/",
      executable: "npm",
      args: ["run", "test:unit"],
      workingDirectory: ".",
      environmentAllowlist: ["CI"],
      timeoutMs: 600_000,
      maxOutputBytes: 262_144,
      expect: { exitCode: 0 },
    },
  ],
}, undefined, 2)}\n`;
