import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { commandLooksLikeHumanOnlyE2e, planLooksLikeHumanOnlyE2e } from "../process/humanOnlyE2e";
import type { VerifierDescriptor } from "../orchestrator/verifierRegistry";

export type VerifierProposal = {
  descriptor: VerifierDescriptor;
  source: string;
  confidence: "declared" | "conventional";
};

export type VerifierDiscovery = {
  proposals: VerifierProposal[];
  skipped: string[];
};

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);

const descriptor = (input: {
  id: string;
  description: string;
  executable: string;
  args: string[];
}): VerifierDescriptor => ({
  id: input.id,
  description: input.description,
  executable: input.executable,
  args: input.args,
  workingDirectory: ".",
  environmentAllowlist: ["CI"],
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  expect: { exitCode: 0 },
});

const readOptional = async (root: string, relative: string): Promise<string | undefined> => {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch {
    return undefined;
  }
};

const PACKAGE_SCRIPT_INTENT = [
  { pattern: /^test(?::unit|:node)?$/u, description: "Unit tests" },
  { pattern: /^(?:lint|eslint)(?::.*)?$/u, description: "Lint" },
  { pattern: /^(?:typecheck|check-types|tsc)(?::.*)?$/u, description: "Type check" },
  { pattern: /^build(?::.*)?$/u, description: "Build" },
  { pattern: /^check(?::.*)?$/u, description: "Repository check" },
] as const;

const packageProposals = (
  source: string,
): { proposals: VerifierProposal[]; skipped: string[] } => {
  const proposals: VerifierProposal[] = [];
  const skipped: string[] = [];
  let parsed: { scripts?: Record<string, unknown> };
  try {
    parsed = JSON.parse(source) as { scripts?: Record<string, unknown> };
  } catch {
    return { proposals, skipped: ["package.json is not readable JSON"] };
  }
  const scripts = Object.entries(parsed.scripts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
  for (const [name, body] of scripts) {
    if (commandLooksLikeHumanOnlyE2e(name) || commandLooksLikeHumanOnlyE2e(body)) {
      skipped.push(`npm run ${name}: browser acceptance verification is human-only`);
      continue;
    }
    const intent = PACKAGE_SCRIPT_INTENT.find((candidate) => candidate.pattern.test(name));
    if (!intent) continue;
    proposals.push({
      descriptor: descriptor({
        id: slug(`npm-${name}`),
        description: `${intent.description} via npm run ${name}`,
        executable: "npm",
        args: name === "test" ? ["test"] : ["run", name],
      }),
      source: `package.json scripts.${name}`,
      confidence: "declared",
    });
  }
  return { proposals, skipped };
};

const conventional = (
  marker: string,
  input: { id: string; description: string; executable: string; args: string[] },
): VerifierProposal => ({
  descriptor: descriptor(input),
  source: marker,
  confidence: "conventional",
});

export const discoverVerifiers = async (root: string): Promise<VerifierDiscovery> => {
  const proposals: VerifierProposal[] = [];
  const skipped: string[] = [];

  const packageJson = await readOptional(root, "package.json");
  if (packageJson !== undefined) {
    const found = packageProposals(packageJson);
    proposals.push(...found.proposals);
    skipped.push(...found.skipped);
  }

  if (await readOptional(root, "Cargo.toml") !== undefined) {
    proposals.push(
      conventional("Cargo.toml", {
        id: "cargo-test",
        description: "Unit tests via cargo test",
        executable: "cargo",
        args: ["test", "--locked"],
      }),
      conventional("Cargo.toml", {
        id: "cargo-clippy",
        description: "Lint via cargo clippy",
        executable: "cargo",
        args: ["clippy", "--locked", "--", "-D", "warnings"],
      }),
    );
  }

  if (await readOptional(root, "go.mod") !== undefined) {
    proposals.push(
      conventional("go.mod", {
        id: "go-test",
        description: "Unit tests via go test",
        executable: "go",
        args: ["test", "./..."],
      }),
      conventional("go.mod", {
        id: "go-vet",
        description: "Static analysis via go vet",
        executable: "go",
        args: ["vet", "./..."],
      }),
    );
  }

  const python = await readOptional(root, "pyproject.toml");
  if (python !== undefined) {
    proposals.push(
      conventional("pyproject.toml", {
        id: "pytest",
        description: "Unit tests via pytest",
        executable: "pytest",
        args: ["-q"],
      }),
    );
    if (/\bruff\b/u.test(python)) {
      proposals.push(
        conventional("pyproject.toml", {
          id: "ruff-check",
          description: "Lint via ruff",
          executable: "ruff",
          args: ["check", "."],
        }),
      );
    }
  }

  const unique = new Map<string, VerifierProposal>();
  proposals.forEach((proposal) => {
    // Discovery never proposes a descriptor the registry parser would reject, so a
    // confirmed bootstrap always writes a registry that loads.
    if (planLooksLikeHumanOnlyE2e(proposal.descriptor.executable, proposal.descriptor.args)) {
      skipped.push(`${proposal.descriptor.id}: browser acceptance verification is human-only`);
      return;
    }
    if (!unique.has(proposal.descriptor.id)) unique.set(proposal.descriptor.id, proposal);
  });
  return { proposals: Array.from(unique.values()), skipped };
};

export const verifierRegistryDocument = (descriptors: VerifierDescriptor[]): string =>
  `${JSON.stringify({ version: 1, verifiers: descriptors }, undefined, 2)}\n`;
