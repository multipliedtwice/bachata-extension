import {
  gitWorktreeRequired,
  selectedWriteScope,
  type WorkspaceRepositoryProbe,
} from "../adapters/workspacePolicyAudit";
import type { PipelineAgentOptions } from "../pipeline/runner";
import { turnExecutionPolicy } from "./turnStream";

/**
 * The project a pipeline runs against is checked once, before any participant is invoked. A
 * participant whose own turn could never pass validation is refused here for the whole run, so no
 * provider does work that would be discarded and no participant is reported as having answered.
 */
export type ProjectPreflightParticipant = {
  participant: string;
  step: string;
  workingDirectory: string | undefined;
  lookupError?: string | undefined;
};

export type ProjectPreflightReason = "noFolder" | "notGitWorktree" | "unresolved";

export type ProjectPreflightFailure = {
  reason: ProjectPreflightReason;
  folder?: string;
  detail?: string;
  participants: Array<{ participant: string; step: string }>;
  message: string;
};

export const participantRequiresGitWorktree = (
  options: PipelineAgentOptions,
  unattended: boolean,
): boolean => {
  const policy = turnExecutionPolicy({ ...options, unattended });
  return gitWorktreeRequired({
    automated: policy.automated,
    readOnly: policy.readOnly,
    writeScope: selectedWriteScope({
      writeScope: options.writeScope,
      readOnly: policy.readOnly,
      defaultScope: policy.defaultScope,
    }),
  });
};

const blockingCause = (
  workingDirectory: string | undefined,
  probe: WorkspaceRepositoryProbe | undefined,
  lookupError: string | undefined,
): { reason: ProjectPreflightReason; detail?: string } | undefined => {
  if (lookupError !== undefined) return { reason: "unresolved", detail: lookupError };
  if (workingDirectory === undefined) return { reason: "noFolder" };
  if (probe === undefined) return { reason: "unresolved", detail: "The project folder was not checked." };
  if (probe.kind === "worktree") return undefined;
  const detail = probe.detail.trim();
  return {
    reason: probe.kind === "notWorktree" ? "notGitWorktree" : "unresolved",
    ...(detail === "" ? {} : { detail }),
  };
};

const participantsSentence = (participants: ReadonlyArray<{ participant: string; step: string }>): string => {
  const described = [...new Set(participants.map((entry) => `${entry.participant} in “${entry.step}”`))];
  const shown = described.slice(0, 2);
  const hidden = described.length - shown.length;
  return hidden > 0
    ? `${shown.join(", ")} and ${String(hidden)} more participant${hidden === 1 ? "" : "s"}`
    : shown.join(" and ");
};

export const projectPreflightFailure = (input: {
  participants: readonly ProjectPreflightParticipant[];
  probes: ReadonlyMap<string, WorkspaceRepositoryProbe>;
}): ProjectPreflightFailure | undefined => {
  const blocked = input.participants.flatMap((participant) => {
    const cause = blockingCause(
      participant.workingDirectory,
      participant.workingDirectory === undefined ? undefined : input.probes.get(participant.workingDirectory),
      participant.lookupError,
    );
    return cause === undefined ? [] : [{ participant, cause }];
  });
  const first = blocked[0];
  if (first === undefined) return undefined;
  const folder = first.participant.workingDirectory;
  const participants = blocked
    .filter((entry) => entry.participant.workingDirectory === folder && entry.cause.reason === first.cause.reason)
    .map((entry) => ({ participant: entry.participant.participant, step: entry.participant.step }));
  const who = participantsSentence(participants);
  const location = {
    ...(folder === undefined ? {} : { folder }),
    ...(first.cause.detail === undefined ? {} : { detail: first.cause.detail }),
  };
  if (first.cause.reason === "unresolved") {
    return {
      reason: "unresolved",
      ...location,
      participants,
      message: `Bachata could not resolve the project ${folder === undefined ? "folder" : `at ${folder}`}, so it did not start ${who}.`,
    };
  }
  return {
    reason: first.cause.reason,
    ...location,
    participants,
    message: folder === undefined
      ? `Choose a Git project folder. No project folder is selected, and ${who} may change files, so Bachata did not start them.`
      : `Choose a Git project folder. ${folder} is not inside a Git worktree, and ${who} may change files, so Bachata needs Git to validate those changes and did not start them.`,
  };
};

const preflightFailures = new WeakMap<Error, ProjectPreflightFailure>();

export const projectPreflightError = (failure: ProjectPreflightFailure): Error => {
  const error = new Error(failure.message);
  preflightFailures.set(error, failure);
  return error;
};

export const projectPreflightFailureOf = (error: unknown): ProjectPreflightFailure | undefined =>
  error instanceof Error ? preflightFailures.get(error) : undefined;

export const projectPreflightDetail = (
  failure: ProjectPreflightFailure,
): { reason: ProjectPreflightReason; folder?: string; detail?: string; participants: Array<{ participant: string; step: string }> } => ({
  reason: failure.reason,
  ...(failure.folder === undefined ? {} : { folder: failure.folder }),
  ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  participants: failure.participants.map((entry) => ({ ...entry })),
});
