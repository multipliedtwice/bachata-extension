import {
  findVerifier,
  isVerifierId,
  VERIFIER_COMMAND_PREFIX,
  verifierDescriptorId,
} from "./verifierRegistry";
import type { VerifierRegistry } from "./verifierRegistry";

export const MANAGED_WORKSPACE_INTEGRITY_COMMAND = "bachata:workspace-integrity";
export const MANAGED_PROJECT_CHECKS_COMMAND = "bachata:project-checks";

export const CONTROLLER_VERIFICATION_COMMANDS = new Set([
  MANAGED_WORKSPACE_INTEGRITY_COMMAND,
  MANAGED_PROJECT_CHECKS_COMMAND,
]);

export const isControllerVerificationCommand = (
  command: string,
  registry?: VerifierRegistry,
): boolean => {
  const trimmed = command.trim();
  if (CONTROLLER_VERIFICATION_COMMANDS.has(trimmed)) return true;
  return findVerifier(registry, trimmed) !== undefined;
};

export const isRepositoryVerifierCommand = (command: string): boolean =>
  verifierDescriptorId(command.trim()) !== undefined;

export const isDeclarableVerificationCommand = (command: string): boolean => {
  const trimmed = command.trim();
  return CONTROLLER_VERIFICATION_COMMANDS.has(trimmed) ||
    isVerifierId(verifierDescriptorId(trimmed));
};

/*
 * Autonomous execution runs built-in controller checks by default.
 *
 * A repository verifier names a fixed executable and argument vector, which is enough to
 * refuse a command line that reads as E2E and not enough to know what that process does.
 * `node scripts/check.js` is a valid descriptor and can spawn Cypress from inside the
 * script; no classifier over the command line can see that, and widening the classifier
 * would only move the boundary without changing it.
 *
 * `repositoryVerifiers: "humanApproved"` is the authority that lets a descriptor start.
 * Only one caller passes it: a run started by the Improve command in a workspace where a
 * human recorded the approval. Approval is a human accepting these executables, never a
 * proof that they are safe, and classification is not proof either — someone who approves
 * a descriptor may be approving a process that launches E2E from inside itself. Direct
 * known E2E forms stay refused on the resolved plan even under approval.
 */
export type RepositoryVerifierAuthority = "refused" | "humanApproved";

export const REPOSITORY_VERIFIER_AUTONOMOUS_REFUSAL =
  `Autonomous verification runs controller-owned ${MANAGED_WORKSPACE_INTEGRITY_COMMAND} and ${MANAGED_PROJECT_CHECKS_COMMAND}. A ${VERIFIER_COMMAND_PREFIX}<id> descriptor names an executable Bachata cannot reason about — an ordinary script can start a browser E2E runner from inside itself — so Bachata never starts one unattended without approval. Record one workspace approval and run Bachata: Improve This Project, or run the check yourself.`;

export const autonomousVerificationRefusal = (
  command: string,
  registry?: VerifierRegistry,
  authority: RepositoryVerifierAuthority = "refused",
): string | undefined => {
  const trimmed = command.trim();
  if (CONTROLLER_VERIFICATION_COMMANDS.has(trimmed)) return undefined;
  if (isRepositoryVerifierCommand(trimmed)) {
    if (authority === "refused") return REPOSITORY_VERIFIER_AUTONOMOUS_REFUSAL;
    return findVerifier(registry, trimmed) !== undefined
      ? undefined
      : `"${trimmed}" is not declared in .bachata/verifiers.json, or the registry failed validation.`;
  }
  return `Autonomous verification accepts only controller-owned ${MANAGED_WORKSPACE_INTEGRITY_COMMAND} or ${MANAGED_PROJECT_CHECKS_COMMAND} operations. Arbitrary repository commands and shell wrappers require an interactive human-approved run.`;
};
