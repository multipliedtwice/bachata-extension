import { join } from "node:path";

import type { RunSettingRejection, RunSettingsSnapshot } from "../runtime/settingsSnapshot";

/**
 * EX-3. What a conversation's runtime is configured with, and what its checklist may refuse.
 *
 * Building a runtime for a conversation is mostly callbacks that close over the manager, and those
 * stay where they are. What is not a callback is a projection of the conversation's own record:
 * which storage it owns, whether it is running unattended for a TODO task, and which recorded run
 * settings a replay hands it. That projection, and the refusals a checklist step answers with,
 * were spelled out inside a two-hundred-line options literal.
 */
export type ConversationRuntimeShape = {
  ownerId: string;
  pipelineStorageDirectory: string;
  pipelineScopeRoot?: string;
  managedWorkingDirectoryRoot: string;
  unattendedOrchestration: boolean;
  startBridge: false;
  closeBridge: false;
  recordedRunSettings?: RunSettingsSnapshot | undefined;
  rejectedRecordedRunSettings?: RunSettingRejection[] | undefined;
};

/**
 * A conversation never starts or stops the shared bridge — the manager owns it for every
 * conversation at once, and a runtime that closed it would take the others' browsers with it.
 * A replayed run's recorded settings win over the run's own: a replay is asked to reproduce what
 * the earlier run was given, not what this one would pick up now.
 */
export const conversationRuntimeShape = (input: {
  conversationId: string;
  sharedPipelineStorageDirectory: string;
  storageRoot: string;
  pipelineScopeRoot?: string | undefined;
  orchestrationTaskId?: string | undefined;
  replaySettings?: RunSettingsSnapshot | undefined;
  runSettings?: RunSettingsSnapshot | undefined;
  rejectedRunSettings?: RunSettingRejection[] | undefined;
}): ConversationRuntimeShape => ({
  ownerId: input.conversationId,
  pipelineStorageDirectory: input.sharedPipelineStorageDirectory,
  ...(input.pipelineScopeRoot === undefined ? {} : { pipelineScopeRoot: input.pipelineScopeRoot }),
  managedWorkingDirectoryRoot: join(input.storageRoot, "orchestration"),
  unattendedOrchestration: Boolean(input.orchestrationTaskId),
  startBridge: false,
  closeBridge: false,
  recordedRunSettings: input.replaySettings ?? input.runSettings,
  rejectedRecordedRunSettings: input.rejectedRunSettings,
});

/**
 * Why a checklist step cannot run here.
 *
 * A checklist opens a second conversation and runs it against this one's workspace, so it is
 * refused inside a TODO task — that task already owns a worktree, and nesting one orchestration
 * inside another gives two owners to the same paths. The rest are absences: no host to run it, no
 * folder to run it in, no live runtime to suspend.
 */
export const checklistExecutionRefusal = (input: {
  orchestrationTaskId?: string | undefined;
  hasHost: boolean;
  hostAbsence: string;
  workingDirectory?: string | undefined;
  requiresWorkingDirectory: boolean;
  hasActiveRuntime: boolean;
  requiresActiveRuntime: boolean;
}): string | undefined => {
  if (input.orchestrationTaskId) {
    return "Nested checklist orchestration is not supported inside a TODO task pipeline";
  }
  if (input.requiresWorkingDirectory && !input.workingDirectory) {
    return "Select a working folder before executing a checklist";
  }
  if (!input.hasHost) return input.hostAbsence;
  if (input.requiresActiveRuntime && !input.hasActiveRuntime) {
    return "The parent conversation runtime is unavailable";
  }
  return undefined;
};

export const CHECKLIST_PREFLIGHT_UNAVAILABLE = "Checklist execution preflight is unavailable";
export const CHECKLIST_EXECUTION_UNAVAILABLE = "Checklist execution is unavailable";
