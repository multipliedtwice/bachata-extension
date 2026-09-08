import type { DatabaseSync } from "node:sqlite";
import { parseRunSettings } from "../runtime/settingsSnapshot";

import { parseRunRecheck, parseRunResult } from "../results/projectResult";
import type { RunCatalogRecord, RunCatalogStatus, RunParticipant } from "./catalog";

export type CatalogEventRecord = {
  id: number;
  runRef: string;
  iterationRef?: string | undefined;
  pairRef?: string | undefined;
  stepRef?: string | undefined;
  type: string;
  status?: string | undefined;
  title?: string | undefined;
  payload?: unknown;
  createdAt: string;
};

export const parseCatalogJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const catalogOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

// A stored snapshot is parsed, never trusted. Anything Bachata will not apply is carried out with
// the row so the caller can state it rather than silently fall back to live settings.
const runSettingsFromRow = (value: unknown): Pick<
  RunCatalogRecord,
  "runSettings" | "rejectedRunSettings"
> => {
  const parsed = parseRunSettings(value);
  return {
    ...(parsed.snapshot === undefined ? {} : { runSettings: parsed.snapshot }),
    ...(parsed.rejected.length === 0 ? {} : { rejectedRunSettings: parsed.rejected }),
  };
};

const replaySourceSettingsFromRow = (value: unknown): Pick<
  RunCatalogRecord,
  "replaySourceSettings" | "rejectedReplaySourceSettings"
> => {
  const parsed = parseRunSettings(value);
  return {
    ...(parsed.snapshot === undefined ? {} : { replaySourceSettings: parsed.snapshot }),
    ...(parsed.rejected.length === 0 ? {} : { rejectedReplaySourceSettings: parsed.rejected }),
  };
};

export const runFromCatalogRow = (row: Record<string, unknown>): RunCatalogRecord => ({
  runRef: String(row.run_ref),
  legacyConversationId: catalogOptionalString(row.legacy_conversation_id),
  title: String(row.title),
  input: String(row.input_text ?? ""),
  pipelineId: catalogOptionalString(row.pipeline_id),
  pipelineVersion: typeof row.pipeline_version === "number" ? row.pipeline_version : undefined,
  pipelineHash: catalogOptionalString(row.pipeline_hash),
  pipelineScopeRoot: catalogOptionalString(row.pipeline_scope_root),
  iterationCount: Number(row.iteration_count),
  activeIteration: Number(row.active_iteration),
  workingRoot: catalogOptionalString(row.working_root),
  preparedDraft: catalogOptionalString(row.prepared_draft),
  terminalResult: parseRunResult(parseCatalogJson<unknown>(row.result_json, undefined)),
  latestRecheck: parseRunRecheck(parseCatalogJson<unknown>(row.recheck_json, undefined)),
  parentConversationId: catalogOptionalString(row.parent_conversation_id),
  orchestrationRunId: catalogOptionalString(row.orchestration_run_id),
  orchestrationTaskId: catalogOptionalString(row.orchestration_task_id),
  orchestrationBranch: catalogOptionalString(row.orchestration_branch),
  orchestrationBaseCommit: catalogOptionalString(row.orchestration_base_commit),
  orchestrationPaths: parseCatalogJson<string[]>(row.orchestration_paths_json, []),
  participants: parseCatalogJson<RunParticipant[]>(row.participants_json, []),
  ...runSettingsFromRow(parseCatalogJson<unknown>(row.run_settings_json, undefined)),
  ...replaySourceSettingsFromRow(
    parseCatalogJson<unknown>(row.replay_source_settings_json, undefined),
  ),
  status: String(row.status) as RunCatalogStatus,
  unread: Number(row.unread),
  archived: Number(row.archived) === 1,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export const eventFromCatalogRow = (row: Record<string, unknown>): CatalogEventRecord => ({
  id: Number(row.id),
  runRef: String(row.run_ref),
  iterationRef: catalogOptionalString(row.iteration_ref),
  pairRef: catalogOptionalString(row.pair_ref),
  stepRef: catalogOptionalString(row.step_ref),
  type: String(row.type),
  status: catalogOptionalString(row.status),
  title: catalogOptionalString(row.title),
  payload: parseCatalogJson(row.payload_json, undefined),
  createdAt: String(row.created_at),
});

/**
 * Every read a window performs against the run catalog goes through these queries, so a
 * read-only window sees exactly the rows the writer sees rather than a second projection.
 */
export const readCatalogRuns = (
  database: DatabaseSync,
  includeArchived = false,
): RunCatalogRecord[] => (database.prepare(
  includeArchived
    ? "SELECT * FROM runs ORDER BY updated_at DESC, run_ref"
    : "SELECT * FROM runs WHERE archived = 0 ORDER BY updated_at DESC, run_ref",
).all() as Record<string, unknown>[]).map(runFromCatalogRow);

export const readCatalogRun = (
  database: DatabaseSync,
  runRef: string,
): RunCatalogRecord | undefined => {
  const row = database.prepare("SELECT * FROM runs WHERE run_ref = ?").get(runRef);
  return row ? runFromCatalogRow(row as Record<string, unknown>) : undefined;
};

export const readCatalogActiveRunRef = (database: DatabaseSync): string | undefined =>
  catalogOptionalString((database.prepare(
    "SELECT value FROM catalog_meta WHERE key = 'active_run_ref'",
  ).get() as Record<string, unknown> | undefined)?.value);

export const readCatalogEvents = (
  database: DatabaseSync,
  runRef: string,
  limit = 500,
): CatalogEventRecord[] => (database.prepare(`
  SELECT * FROM events WHERE run_ref = ? ORDER BY id DESC LIMIT ?
`).all(runRef, Math.max(1, Math.min(5000, limit))) as Record<string, unknown>[])
  .reverse()
  .map(eventFromCatalogRow);
