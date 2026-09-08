/**
 * When the selected pipeline may still be changed, and why not.
 *
 * Changing pipelines mid-task would leave the transcript, the queue and any recovery
 * checkpoint describing a run that no longer exists, so the policy refuses while any of them
 * still holds work — and refuses with the sentence the user is shown, not a bare boolean.
 * The order matters: a broken catalog is reported before anything else, because nothing else
 * the policy could say would be true of a catalog that failed to load.
 *
 * The policy lived inside the runtime closure, reachable only by driving a whole runtime into
 * each of the five states it distinguishes.
 */
import type { WorkflowStatus } from "../webview/protocol";

export const hasDurableTaskState = (input: {
  taskDirty: boolean;
  transcriptTotal: number;
  attachmentCount: number;
  queuedMessageCount: number;
  queueStartClaimed: boolean;
  recoveryCheckpointed: boolean;
}): boolean =>
  input.taskDirty ||
  input.transcriptTotal > 0 ||
  input.attachmentCount > 0 ||
  input.queuedMessageCount > 0 ||
  input.queueStartClaimed ||
  input.recoveryCheckpointed;

export const pipelineMutationRefusal = (input: {
  catalogError?: string | undefined;
  operationInFlight: boolean;
  workflowStatus: WorkflowStatus;
  attachmentCount: number;
  durableTaskState: boolean;
}): string | undefined => {
  if (input.catalogError) {
    return input.catalogError;
  }
  if (input.operationInFlight) {
    return "Wait for the active operation before changing pipelines";
  }
  if (input.workflowStatus !== "idle") {
    return "Reset this run before changing pipelines";
  }
  if (input.attachmentCount > 0) {
    return "Remove attachments or reset this run before changing pipelines";
  }
  if (input.durableTaskState) {
    return "Start a new run or reset this run before changing pipelines";
  }
  return undefined;
};

/**
 * EX-3. What a catalog write refuses, apart from performing one.
 *
 * A save and a delete each check the same kinds of thing in a fixed order — the editor is still
 * looking at the scope it opened, the pipeline is one this catalog may change, the revision the
 * editor holds is the revision on disk — and each check has wording a reader has to act on. The
 * chain lived inside the catalog mutation, after a reload and a lock, so reaching a single refusal
 * meant driving a real catalog into that exact state.
 *
 * Optimistic concurrency is the point of the hash checks: two editors open on one pipeline must
 * not silently overwrite each other, so the second one is told to reopen rather than merged.
 */
export const PIPELINE_SCOPE_CHANGED = {
  save: "The pipeline storage scope changed. Reopen the editor before saving.",
  delete: "The pipeline storage scope changed. Reopen the editor before deleting.",
} as const;

export type PipelineSaveState = {
  mode: "create" | "update";
  pipelineId: string;
  requestScopeKey: string;
  scopeKey: string;
  activeScopeKey: string;
  existsInCatalog: boolean;
  isCustom: boolean;
  sourcePipelineId?: string | undefined;
  expectedHash?: string | undefined;
  currentHash?: string | undefined;
  /** Whether the catalog file is on disk; read after the lock, so it can disagree with the catalog. */
  fileExists: boolean;
};

export const pipelineSaveRefusal = (input: PipelineSaveState): string | undefined => {
  if (input.requestScopeKey !== input.scopeKey || input.activeScopeKey !== input.scopeKey) {
    return PIPELINE_SCOPE_CHANGED.save;
  }
  if (input.mode === "create") {
    if (input.existsInCatalog) {
      // A built-in preset and a custom pipeline collide differently: one is reopened, the other
      // can never be written to at all, so the reader is told which case they are in.
      return input.isCustom
        ? `Custom pipeline ${input.pipelineId} already exists; open it before editing`
        : `Pipeline id ${input.pipelineId} belongs to a built-in preset; save it with a new id`;
    }
    return input.fileExists ? `Custom pipeline ${input.pipelineId} already exists on disk` : undefined;
  }
  if (
    !input.sourcePipelineId ||
    input.sourcePipelineId !== input.pipelineId ||
    !input.expectedHash
  ) {
    return "Pipeline update requires its original id and revision";
  }
  if (!input.isCustom) return `Custom pipeline ${input.pipelineId} no longer exists`;
  if (input.currentHash !== input.expectedHash) {
    return `Pipeline ${input.pipelineId} changed in another run. Reopen it before saving.`;
  }
  return input.fileExists ? undefined : `Custom pipeline ${input.pipelineId} no longer exists on disk`;
};

export type PipelineDeleteState = {
  pipelineId: string;
  requestScopeKey: string;
  scopeKey: string;
  activeScopeKey: string;
  isCustom: boolean;
  expectedHash: string;
  currentHash?: string | undefined;
  existsInCatalog: boolean;
  hasCatalogFile: boolean;
  fileExists: boolean;
};

export const pipelineDeleteRefusal = (input: PipelineDeleteState): string | undefined => {
  if (input.requestScopeKey !== input.scopeKey || input.activeScopeKey !== input.scopeKey) {
    return PIPELINE_SCOPE_CHANGED.delete;
  }
  if (!input.isCustom) return "Only existing custom pipelines can be deleted";
  if (input.currentHash !== input.expectedHash) {
    return `Pipeline ${input.pipelineId} changed in another run. Reopen it before deleting.`;
  }
  if (!input.existsInCatalog) return `Unknown pipeline: ${input.pipelineId}`;
  if (!input.hasCatalogFile) return `Custom pipeline ${input.pipelineId} has no catalog file`;
  return input.fileExists ? undefined : `Custom pipeline ${input.pipelineId} no longer exists on disk`;
};
