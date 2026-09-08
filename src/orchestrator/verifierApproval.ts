import { createHash } from "node:crypto";

import { verifierCommand } from "./verifierRegistry";
import type { VerifierDescriptor, VerifierRegistry } from "./verifierRegistry";

/*
 * One persisted workspace-level approval. It says a human accepted that Bachata may start the
 * executables `.bachata/verifiers.json` names during an explicit self-improvement run in this
 * workspace. It is not evidence that those executables are safe: a descriptor names a fixed
 * executable and argument vector, and an ordinary script can start anything from inside
 * itself, including a browser E2E runner. Classification is not proof.
 */
export const REPOSITORY_VERIFIER_APPROVAL_KEY = "bachata.improve.repositoryVerifiers.v1";

const canonicalDescriptor = (descriptor: VerifierDescriptor) => ({
  id: descriptor.id,
  executable: descriptor.executable,
  args: descriptor.args,
  workingDirectory: descriptor.workingDirectory,
  environmentAllowlist: [...descriptor.environmentAllowlist].sort(),
  timeoutMs: descriptor.timeoutMs,
  maxOutputBytes: descriptor.maxOutputBytes,
  expect: {
    exitCode: descriptor.expect.exitCode,
    stdoutIncludes: descriptor.expect.stdoutIncludes ?? null,
    stdoutExcludes: descriptor.expect.stdoutExcludes ?? null,
  },
});

/*
 * The identity of an approved descriptor set: what would run, not when it was approved. It is
 * computed from the parsed registry, so reformatting the file, reordering its descriptors,
 * spelling out a default or editing a description leaves an approval standing, while a changed
 * executable, argument vector, working directory, environment, bound or expectation does not.
 */
export const verifierRegistryDigest = (registry: VerifierRegistry | undefined): string =>
  createHash("sha256")
    .update(JSON.stringify(
      [...(registry?.verifiers ?? [])]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map(canonicalDescriptor),
    ))
    .digest("hex");

/*
 * EX-G6-08. Approval is per repository, not per window.
 *
 * A window can hold more than one repository, and the approval a person gave for the executables
 * one of them declares says nothing about the executables another one declares. The stored value
 * was a single boolean with no repository in it, so approving one repository's checks approved
 * every repository the window ever opened. It is a record now, keyed by repository root.
 *
 * A stored `true` from the older shape names no repository, so it cannot be honoured for one: it
 * reads as no approval, and the person is asked again. That is the fail-safe direction.
 */
const digestPattern = /^[0-9a-f]{64}$/u;

type RecordedApproval = string | true;

const recordedApproval = (value: unknown): RecordedApproval | undefined =>
  value === true
    ? true
    : typeof value === "string" && digestPattern.test(value)
      ? value
      : undefined;

const approvalRecord = (value: unknown): Record<string, RecordedApproval> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([root, approved]) => [root, recordedApproval(approved)] as const)
      .filter((entry): entry is readonly [string, RecordedApproval] => entry[1] !== undefined),
  );
};

/*
 * The approval also names the descriptor set it approved. A registry the person never saw — a
 * teammate's commit, a branch checkout, a merge — digests differently, and a digest that does
 * not match the recorded one reads as no approval, so the person is asked again. An approval
 * recorded before this binding existed names no descriptor set, so it cannot answer for one
 * either. A caller that passes no digest learns only that some approval was recorded.
 */
export const repositoryVerifiersApproved = (
  stored: unknown,
  repositoryRoot: string,
  registryDigest?: string,
): boolean => {
  const recorded = approvalRecord(stored)[repositoryRoot];
  if (recorded === undefined) return false;
  return registryDigest === undefined ? true : recorded === registryDigest;
};

export const withRepositoryVerifierApproval = (
  stored: unknown,
  repositoryRoot: string,
  registryDigest?: string,
): Record<string, RecordedApproval> => ({
  ...approvalRecord(stored),
  [repositoryRoot]: registryDigest ?? true,
});

export const withoutRepositoryVerifierApproval = (
  stored: unknown,
  repositoryRoot: string,
): Record<string, RecordedApproval> | undefined => {
  const { [repositoryRoot]: _removed, ...rest } = approvalRecord(stored);
  return Object.keys(rest).length === 0 ? undefined : rest;
};

export const approvedRepositoryRoots = (stored: unknown): string[] =>
  Object.keys(approvalRecord(stored)).sort();

export const REPOSITORY_VERIFIER_APPROVAL_TITLE =
  "Let Bachata: Improve This Project start the checks this repository declares?";

/*
 * A `bachata:verifier:<id>` name is free text and carries no evidence of what it starts, so the
 * executable and argument vector the person is being asked about are written out.
 */
const descriptorLine = (descriptor: VerifierDescriptor): string =>
  `- ${verifierCommand(descriptor.id)}: ${[descriptor.executable, ...descriptor.args].join(" ")}${
    descriptor.workingDirectory.length > 0 ? ` (in ${descriptor.workingDirectory})` : ""
  }`;

export const repositoryVerifierApprovalDetail = (input: {
  workspaceRoot: string;
  commands: string[];
  descriptors?: VerifierDescriptor[];
}): string => [
  `Repository: ${input.workspaceRoot}`,
  "",
  "These descriptors are declared in .bachata/verifiers.json and would run during an explicit Improve run:",
  ...(input.descriptors === undefined
    ? input.commands.map((command) => `- ${command}`)
    : input.descriptors.map(descriptorLine)),
  "",
  "Approving this records one workspace-level approval. It does not prove these commands are safe: each names an executable Bachata cannot reason about, and an ordinary script can start another process — including a browser E2E runner — from inside itself. Classification is not proof.",
  "Bachata still refuses any descriptor whose resolved executable, arguments, or package script read as direct E2E.",
  "Remove the approval at any time: run Bachata: Repository Verifiers and choose \"Remove this workspace's approval\".",
].join("\n");
