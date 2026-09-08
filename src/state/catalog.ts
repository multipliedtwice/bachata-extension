import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createReference, ReferencePrefix } from "./identifiers";
import { describeTimeoutBound, isSupportedTimeoutMs } from "./timeoutBounds";
import { openSqliteDatabase, withImmediateTransaction } from "./sqlite";
import {
  createLongitudinalStore,
  LONGITUDINAL_TABLES,
  migrateActiveInitiative,
  migrateExternalEvidence,
  migrateFindingAliases,
  migrateFindingFixRuns,
  migrateFixRunProvenance,
  migrateLongitudinal,
  migrateLongitudinalRounds,
} from "./longitudinalStore";
import type { LongitudinalStore } from "./longitudinalStore";
import type { RunSettingRejection, RunSettingsSnapshot } from "../runtime/settingsSnapshot";
import { serializeWorkspaceWriterFence, WorkspaceWriterFence } from "./workspaceMutationFence";
import {
  readCatalogActiveRunRef,
  readCatalogEvents,
  readCatalogRun,
  readCatalogRuns,
  runFromCatalogRow,
} from "./catalogReads";
import {
  type RunRecheckRecord,
  type RunResultCenter,
} from "../results/projectResult";

export type RunCatalogStatus =
  | "draft"
  | "running"
  | "waiting"
  | "paused"
  | "failed"
  | "completed"
  | "stopped"
  | "abandoned"
  | "archived";

export type RunParticipant = {
  name: string;
  adapter: string;
  model?: string;
};

export type RunCatalogRecord = {
  runRef: string;
  legacyConversationId?: string | undefined;
  title: string;
  input: string;
  pipelineId?: string | undefined;
  pipelineVersion?: number | undefined;
  pipelineHash?: string | undefined;
  pipelineScopeRoot?: string | undefined;
  iterationCount: number;
  activeIteration: number;
  workingRoot?: string | undefined;
  preparedDraft?: string | undefined;
  terminalResult?: RunResultCenter | undefined;
  latestRecheck?: RunRecheckRecord | undefined;
  parentConversationId?: string | undefined;
  orchestrationRunId?: string | undefined;
  orchestrationTaskId?: string | undefined;
  orchestrationBranch?: string | undefined;
  orchestrationBaseCommit?: string | undefined;
  orchestrationPaths?: string[] | undefined;
  participants?: RunParticipant[] | undefined;
  runSettings?: RunSettingsSnapshot | undefined;
  // The settings the run a replay was created from recorded. Kept beside the run, and apart
  // from its own, so a replay that has not executed yet still knows what to execute with after
  // a restart, and so an export never presents the source's values as this run's.
  replaySourceSettings?: RunSettingsSnapshot | undefined;
  // Values a stored snapshot carried that Bachata will not apply. Read-only: the writer records a
  // snapshot it built itself, so a non-empty list means the row was edited outside Bachata.
  rejectedRunSettings?: RunSettingRejection[] | undefined;
  rejectedReplaySourceSettings?: RunSettingRejection[] | undefined;
  status: RunCatalogStatus;
  unread: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatCatalogRecord = {
  chatRef: string;
  runRef: string;
  iterationRef?: string | undefined;
  pairRef?: string | undefined;
  agentId: string;
  role: string;
  provider: string;
  adapter: string;
  providerSessionId?: string | undefined;
  providerConversationUrl?: string | undefined;
  providerConversationIdentity?: string | undefined;
  providerMessageCursor?: string | undefined;
  displayTitle: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type InteractionStatus =
  | "pending"
  | "paused"
  | "resolved"
  | "cancelled";

export type InteractionRecord = {
  interactionRef: string;
  runRef: string;
  stepRef?: string | undefined;
  kind: string;
  sourceKey?: string | undefined;
  prompt: string;
  options: unknown[];
  context?: unknown | undefined;
  selected: string[];
  freeText: string;
  status: InteractionStatus;
  createdAt: string;
  deadlineAt?: string | undefined;
  remainingMs?: number | undefined;
  pauseReason?: string | undefined;
  resolutionSource?: string | undefined;
  resolution?: unknown | undefined;
  resolvedAt?: string | undefined;
  handledAt?: string | undefined;
};

export type ChecklistItemRecord = {
  issueId: string;
  title: string;
  details: string;
  dependencies: string[];
  paths: string[];
  selected: boolean;
  position: number;
};

export type CreateInteractionInput = {
  runRef: string;
  stepRef?: string;
  kind: string;
  sourceKey?: string;
  prompt: string;
  options?: unknown[];
  context?: unknown;
  timeoutMs?: number;
};

export type StateCatalogOptions = {
  now?: (() => Date) | undefined;
  referenceFactory?: ((prefix: ReferencePrefix) => string) | undefined;
  writerFence?: WorkspaceWriterFence | undefined;
  assertWritable?: (() => void) | undefined;
  retention?: {
    eventsPerRun?: number | undefined;
    outputsPerRun?: number | undefined;
    handledInteractionsPerRun?: number | undefined;
    completedAttemptsPerRun?: number | undefined;
  };
};

export type StateCatalog = {
  path: string;
  close: () => void;
  longitudinal: LongitudinalStore;
  createRun: (input: {
    title: string;
    input?: string;
    legacyConversationId?: string;
    pipelineId?: string;
    pipelineVersion?: number;
    pipelineHash?: string;
    pipelineScopeRoot?: string;
    iterationCount?: number;
    workingRoot?: string;
    preparedDraft?: string;
    terminalResult?: RunResultCenter;
    latestRecheck?: RunRecheckRecord;
    parentConversationId?: string;
    orchestrationRunId?: string;
    orchestrationTaskId?: string;
    orchestrationBranch?: string;
    orchestrationBaseCommit?: string;
    orchestrationPaths?: string[];
    participants?: RunParticipant[];
    status?: RunCatalogStatus;
  }) => RunCatalogRecord;
  upsertRun: (run: RunCatalogRecord) => void;
  commitRuns: (runs: RunCatalogRecord[], deletedRunRefs: string[], activeRunRef?: string) => void;
  getRun: (runRef: string) => RunCatalogRecord | undefined;
  listRuns: (includeArchived?: boolean) => RunCatalogRecord[];
  deleteRun: (runRef: string) => void;
  getActiveRunRef: () => string | undefined;
  setActiveRunRef: (runRef?: string) => void;
  createIteration: (input: {
    runRef: string;
    index: number;
    status?: string;
    repositoryCommit?: string;
  }) => string;
  updateIteration: (iterationRef: string, input: {
    status: string;
    repositoryCommit?: string;
    completed?: boolean;
  }) => void;
  listIterations: (runRef: string) => Array<{
    iterationRef: string;
    index: number;
    status: string;
    repositoryCommit?: string | undefined;
    createdAt: string;
    completedAt?: string | undefined;
  }>;
  createPair: (input: {
    runRef: string;
    iterationRef?: string | undefined;
    taskId?: string | undefined;
    pipelineStepId?: string | undefined;
    workingRoot?: string | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    baseCommit?: string | undefined;
    scope?: unknown;
    status?: string | undefined;
  }) => string;
  updatePair: (pairRef: string, input: {
    status: string;
    completed?: boolean;
  }) => void;
  getPairForIteration: (iterationRef: string) => {
    pairRef: string;
    status: string;
    completedAt?: string | undefined;
  } | undefined;
  createChat: (input: Omit<ChatCatalogRecord, "chatRef" | "createdAt" | "updatedAt" | "agentId"> & { agentId?: string }) => ChatCatalogRecord;
  upsertChat: (chat: ChatCatalogRecord) => void;
  listChats: (runRef: string) => ChatCatalogRecord[];
  ensureStep: (input: {
    runRef: string;
    iterationRef?: string | undefined;
    pipelineStepId: string;
    name: string;
    index: number;
    status?: string | undefined;
  }) => string;
  updateStep: (stepRef: string, input: {
    status: string;
    started?: boolean;
    completed?: boolean;
  }) => void;
  appendEvent: (input: {
    runRef: string;
    iterationRef?: string | undefined;
    pairRef?: string | undefined;
    stepRef?: string | undefined;
    type: string;
    status?: string | undefined;
    title?: string | undefined;
    payload?: unknown;
  }) => number;
  latestExecutionRef: (runRef: string) => string | undefined;
  listEvents: (runRef: string, limit?: number) => Array<{
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
  }>;
  saveStructuredOutput: (input: {
    runRef: string;
    iterationRef?: string | undefined;
    stepRef?: string | undefined;
    name: string;
    schemaId?: string | undefined;
    contentHash: string;
    value: unknown;
  }) => string;
  listStructuredOutputs: (runRef: string) => Array<{
    outputRef: string;
    name: string;
    schemaId?: string | undefined;
    contentHash: string;
    value: unknown;
    createdAt: string;
  }>;
  createInteraction: (input: CreateInteractionInput) => InteractionRecord;
  getInteraction: (interactionRef: string) => InteractionRecord | undefined;
  replaceChecklistItems: (
    interactionRef: string,
    items: Array<Omit<ChecklistItemRecord, "selected" | "position">>,
  ) => void;
  listChecklistItems: (interactionRef: string) => ChecklistItemRecord[];
  updateChecklistSelection: (interactionRef: string, selectedIssueIds: string[]) => void;
  listOpenInteractions: (runRef?: string) => InteractionRecord[];
  listInteractions: (runRef: string) => InteractionRecord[];
  updateInteractionDraft: (interactionRef: string, input: {
    selected?: string[] | undefined;
    freeText?: string | undefined;
    pauseReason?: string | undefined;
  }) => InteractionRecord;
  pauseInteraction: (interactionRef: string, reason: string) => InteractionRecord;
  resumeInteraction: (interactionRef: string) => InteractionRecord;
  resolveInteraction: (interactionRef: string, source: string, resolution: unknown) => boolean;
  resolveDueInteractions: () => InteractionRecord[];
  overrideTimedOutInteraction: (
    interactionRef: string,
    source: string,
    resolution: unknown,
  ) => InteractionRecord;
  listUnhandledTimeouts: () => InteractionRecord[];
  markInteractionHandled: (interactionRef: string) => void;
  nextDeadlineAt: () => string | undefined;
};

const maxJsonBytes = 262_144;

const json = (value: unknown): string => {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, "utf8") > maxJsonBytes) {
    throw new Error(`Structured catalog value exceeds ${String(maxJsonBytes)} bytes`);
  }
  return serialized;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const interactionPayloadHash = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.payloadHash === "string"
    ? value.payloadHash
    : undefined;

const runFromRow = runFromCatalogRow;

const chatFromRow = (row: Record<string, unknown>): ChatCatalogRecord => ({
  chatRef: String(row.chat_ref),
  runRef: String(row.run_ref),
  iterationRef: optionalString(row.iteration_ref),
  pairRef: optionalString(row.pair_ref),
  agentId: String(row.agent_id ?? row.role),
  role: String(row.role),
  provider: String(row.provider),
  adapter: String(row.adapter),
  providerSessionId: optionalString(row.provider_session_id),
  providerConversationUrl: optionalString(row.provider_conversation_url),
  providerConversationIdentity: optionalString(row.provider_conversation_identity),
  providerMessageCursor: optionalString(row.provider_message_cursor),
  displayTitle: String(row.display_title),
  status: String(row.status),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const interactionFromRow = (row: Record<string, unknown>): InteractionRecord => ({
  interactionRef: String(row.interaction_ref),
  runRef: String(row.run_ref),
  stepRef: optionalString(row.step_ref),
  kind: String(row.kind),
  sourceKey: optionalString(row.source_key),
  prompt: String(row.prompt),
  options: parseJson<unknown[]>(row.options_json, []),
  context: row.context_json === null || row.context_json === undefined
    ? undefined
    : parseJson(row.context_json, undefined),
  selected: parseJson<string[]>(row.selected_json, []),
  freeText: String(row.free_text ?? ""),
  status: String(row.status) as InteractionStatus,
  createdAt: String(row.created_at),
  deadlineAt: optionalString(row.deadline_at),
  remainingMs: typeof row.remaining_ms === "number" ? row.remaining_ms : undefined,
  pauseReason: optionalString(row.pause_reason),
  resolutionSource: optionalString(row.resolution_source),
  resolution: row.resolution_json === null || row.resolution_json === undefined
    ? undefined
    : parseJson(row.resolution_json, undefined),
  resolvedAt: optionalString(row.resolved_at),
  handledAt: optionalString(row.handled_at),
});

const insertReference = <T>(
  prefix: ReferencePrefix,
  factory: (prefix: ReferencePrefix) => string,
  insert: (reference: string) => T,
): T => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return insert(factory(prefix));
    } catch (error) {
      lastError = error;
      const sqlite = error as { code?: unknown; errcode?: unknown };
      if (sqlite.code !== "ERR_SQLITE_ERROR" || (sqlite.errcode !== 1555 && sqlite.errcode !== 2067)) {
        throw error;
      }
    }
  }
  throw new Error("Could not allocate a unique Bachata reference", { cause: lastError });
};

const runMigration = (
  database: DatabaseSync,
  version: number,
  operation: () => void,
): void => {
  withImmediateTransaction(database, () => {
    const applied = database
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = ?")
      .get(version) as { applied: number } | undefined;
    if (!applied) {
      operation();
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)")
        .run(version, new Date().toISOString());
    }
  });
};

// A run recorded before this column existed keeps no settings snapshot. It reads back as
// undefined, so a replay of that run states that it has no recorded settings rather than
// borrowing whatever the live settings happen to be.
const migrateRunSettingsColumn = (database: DatabaseSync): void => {
  const columns = new Set(
    database.prepare("PRAGMA table_info(runs)").all()
      .map((row) => String((row as Record<string, unknown>).name)),
  );
  if (columns.has("run_settings_json")) return;
  database.exec("ALTER TABLE runs ADD COLUMN run_settings_json TEXT");
};

// A replay created before this column existed kept its source snapshot only in memory, so it
// reads back as absent and the replay runs on live settings — stated, not guessed.
const migrateReplaySourceSettingsColumn = (database: DatabaseSync): void => {
  const columns = new Set(
    database.prepare("PRAGMA table_info(runs)").all()
      .map((row) => String((row as Record<string, unknown>).name)),
  );
  if (columns.has("replay_source_settings_json")) return;
  database.exec("ALTER TABLE runs ADD COLUMN replay_source_settings_json TEXT");
};

const migrate = (database: DatabaseSync): void => {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  runMigration(database, 1, () => {
    database.exec(`
        CREATE TABLE runs (
          run_ref TEXT PRIMARY KEY,
          legacy_conversation_id TEXT UNIQUE,
          title TEXT NOT NULL,
          input_text TEXT NOT NULL DEFAULT '',
          pipeline_id TEXT,
          pipeline_version INTEGER,
          pipeline_hash TEXT,
          pipeline_scope_root TEXT,
          iteration_count INTEGER NOT NULL DEFAULT 1 CHECK(iteration_count >= 1),
          active_iteration INTEGER NOT NULL DEFAULT 1 CHECK(active_iteration >= 1),
          working_root TEXT,
          parent_conversation_id TEXT,
          orchestration_run_id TEXT,
          orchestration_task_id TEXT,
          orchestration_branch TEXT,
          orchestration_base_commit TEXT,
          orchestration_paths_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL,
          unread INTEGER NOT NULL DEFAULT 0 CHECK(unread >= 0),
          archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX runs_updated_idx ON runs(archived, updated_at DESC);

        CREATE TABLE iterations (
          iteration_ref TEXT PRIMARY KEY,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          iteration_index INTEGER NOT NULL CHECK(iteration_index >= 1),
          status TEXT NOT NULL,
          repository_commit TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(run_ref, iteration_index)
        );

        CREATE TABLE pairs (
          pair_ref TEXT PRIMARY KEY,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          iteration_ref TEXT REFERENCES iterations(iteration_ref) ON DELETE CASCADE,
          task_id TEXT,
          pipeline_step_id TEXT,
          working_root TEXT,
          worktree_path TEXT,
          branch TEXT,
          base_commit TEXT,
          scope_json TEXT NOT NULL DEFAULT 'null',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX pairs_run_idx ON pairs(run_ref, created_at);

        CREATE TABLE bachata_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pair_ref TEXT NOT NULL REFERENCES pairs(pair_ref) ON DELETE CASCADE,
          chat_ref TEXT,
          role TEXT NOT NULL,
          start_step_ref TEXT,
          end_step_ref TEXT,
          reason TEXT,
          created_at TEXT NOT NULL,
          ended_at TEXT
        );

        CREATE TABLE chats (
          chat_ref TEXT PRIMARY KEY,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          iteration_ref TEXT REFERENCES iterations(iteration_ref) ON DELETE CASCADE,
          pair_ref TEXT REFERENCES pairs(pair_ref) ON DELETE SET NULL,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT NOT NULL,
          adapter TEXT NOT NULL,
          provider_session_id TEXT,
          provider_conversation_url TEXT,
          provider_conversation_identity TEXT,
          provider_message_cursor TEXT,
          display_title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX chats_run_idx ON chats(run_ref, created_at);
        CREATE UNIQUE INDEX chats_agent_iteration_idx ON chats(run_ref, iteration_ref, agent_id);

        CREATE TABLE steps (
          step_ref TEXT PRIMARY KEY,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          iteration_ref TEXT REFERENCES iterations(iteration_ref) ON DELETE CASCADE,
          pipeline_step_id TEXT NOT NULL,
          name TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );

        CREATE TABLE attempts (
          attempt_ref TEXT PRIMARY KEY,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          step_ref TEXT REFERENCES steps(step_ref) ON DELETE CASCADE,
          pair_ref TEXT REFERENCES pairs(pair_ref) ON DELETE SET NULL,
          attempt_index INTEGER NOT NULL,
          status TEXT NOT NULL,
          failure_kind TEXT,
          failure_text TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE interactions (
          interaction_ref TEXT PRIMARY KEY,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          step_ref TEXT REFERENCES steps(step_ref) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          source_key TEXT,
          prompt TEXT NOT NULL,
          options_json TEXT NOT NULL DEFAULT '[]',
          context_json TEXT,
          selected_json TEXT NOT NULL DEFAULT '[]',
          free_text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          deadline_at TEXT,
          remaining_ms INTEGER,
          pause_reason TEXT,
          resolution_source TEXT,
          resolution_json TEXT,
          resolved_at TEXT,
          handled_at TEXT
        );
        CREATE INDEX interactions_deadline_idx ON interactions(status, deadline_at);
        CREATE UNIQUE INDEX interactions_source_idx ON interactions(run_ref, source_key)
          WHERE source_key IS NOT NULL;
        CREATE INDEX interactions_run_idx ON interactions(run_ref, created_at);

        CREATE TABLE checklist_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          interaction_ref TEXT NOT NULL REFERENCES interactions(interaction_ref) ON DELETE CASCADE,
          issue_id TEXT NOT NULL,
          title TEXT NOT NULL,
          details TEXT NOT NULL,
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          paths_json TEXT NOT NULL DEFAULT '[]',
          selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0, 1)),
          position INTEGER NOT NULL,
          UNIQUE(interaction_ref, issue_id)
        );

        CREATE TABLE structured_outputs (
          output_ref TEXT PRIMARY KEY,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          iteration_ref TEXT REFERENCES iterations(iteration_ref) ON DELETE CASCADE,
          step_ref TEXT REFERENCES steps(step_ref) ON DELETE SET NULL,
          name TEXT NOT NULL,
          schema_id TEXT,
          content_hash TEXT NOT NULL,
          value_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX structured_outputs_run_idx ON structured_outputs(run_ref, created_at);

        CREATE TABLE resources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          pair_ref TEXT REFERENCES pairs(pair_ref) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          identifier TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          released_at TEXT,
          UNIQUE(kind, identifier)
        );

        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_ref TEXT NOT NULL REFERENCES runs(run_ref) ON DELETE CASCADE,
          iteration_ref TEXT REFERENCES iterations(iteration_ref) ON DELETE CASCADE,
          pair_ref TEXT REFERENCES pairs(pair_ref) ON DELETE SET NULL,
          step_ref TEXT REFERENCES steps(step_ref) ON DELETE SET NULL,
          type TEXT NOT NULL,
          status TEXT,
          title TEXT,
          payload_json TEXT NOT NULL DEFAULT 'null',
          created_at TEXT NOT NULL
        );
        CREATE INDEX events_run_idx ON events(run_ref, id DESC);

        CREATE TABLE catalog_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
    `);
  });

  runMigration(database, 2, () => {
    const columns = new Set(
      database.prepare("PRAGMA table_info(interactions)").all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    if (!columns.has("source_key")) {
      database.exec("ALTER TABLE interactions ADD COLUMN source_key TEXT");
    }
    if (!columns.has("context_json")) {
      database.exec("ALTER TABLE interactions ADD COLUMN context_json TEXT");
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS interactions_source_idx ON interactions(run_ref, source_key)
        WHERE source_key IS NOT NULL;
    `);
  });

  runMigration(database, 3, () => {
    const columns = new Set(
      database.prepare("PRAGMA table_info(chats)").all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    if (!columns.has("agent_id")) {
      database.exec("ALTER TABLE chats ADD COLUMN agent_id TEXT");
      database.exec("UPDATE chats SET agent_id = role WHERE agent_id IS NULL");
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS chats_agent_iteration_idx
        ON chats(run_ref, iteration_ref, agent_id);
    `);
  });

  runMigration(database, 4, () => {
    const columns = new Set(
      database.prepare("PRAGMA table_info(runs)").all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    if (!columns.has("orchestration_branch")) {
      database.exec("ALTER TABLE runs ADD COLUMN orchestration_branch TEXT");
    }
    if (!columns.has("orchestration_base_commit")) {
      database.exec("ALTER TABLE runs ADD COLUMN orchestration_base_commit TEXT");
    }
    if (!columns.has("orchestration_paths_json")) {
      database.exec("ALTER TABLE runs ADD COLUMN orchestration_paths_json TEXT NOT NULL DEFAULT '[]'");
    }
  });

  runMigration(database, 5, () => {
    const columns = new Set(
      database.prepare("PRAGMA table_info(runs)").all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    if (!columns.has("pipeline_scope_root")) {
      database.exec("ALTER TABLE runs ADD COLUMN pipeline_scope_root TEXT");
    }
  });

  runMigration(database, 6, () => {
    const columns = new Set(
      database.prepare("PRAGMA table_info(runs)").all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    if (!columns.has("participants_json")) {
      database.exec("ALTER TABLE runs ADD COLUMN participants_json TEXT NOT NULL DEFAULT '[]'");
    }
  });

  runMigration(database, 8, () => {
    const columns = new Set(
      database.prepare("PRAGMA table_info(runs)").all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    if (!columns.has("result_json")) {
      database.exec("ALTER TABLE runs ADD COLUMN result_json TEXT");
    }
  });

  runMigration(database, 9, () => {
    const columns = new Set(
      database.prepare("PRAGMA table_info(runs)").all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    if (!columns.has("recheck_json")) {
      database.exec("ALTER TABLE runs ADD COLUMN recheck_json TEXT");
    }
  });

  runMigration(database, 7, () => {
    const columns = new Set(
      database.prepare("PRAGMA table_info(runs)").all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    if (!columns.has("prepared_draft")) {
      database.exec("ALTER TABLE runs ADD COLUMN prepared_draft TEXT");
    }
  });

  runMigration(database, 10, () => {
    migrateLongitudinal(database);
  });

  runMigration(database, 11, () => {
    migrateLongitudinalRounds(database);
  });

  runMigration(database, 12, () => {
    migrateFindingAliases(database);
  });

  runMigration(database, 13, () => {
    migrateFindingFixRuns(database);
  });

  runMigration(database, 14, () => {
    migrateActiveInitiative(database);
  });

  runMigration(database, 15, () => {
    migrateFixRunProvenance(database);
  });

  runMigration(database, 16, () => {
    migrateRunSettingsColumn(database);
  });

  runMigration(database, 17, () => {
    migrateExternalEvidence(database);
  });

  runMigration(database, 18, () => {
    migrateReplaySourceSettingsColumn(database);
  });
};

const installWriterFence = (database: DatabaseSync): void => {
  const condition = `(SELECT value FROM catalog_meta WHERE key = 'writer_fence') IS NOT NULL
    AND (SELECT value FROM catalog_meta WHERE key = 'writer_fence') <> bachata_writer_fence()`;
  const tables = [
    "runs",
    "iterations",
    "pairs",
    "bachata_assignments",
    "chats",
    "steps",
    "attempts",
    "interactions",
    "checklist_items",
    "structured_outputs",
    "resources",
    "events",
    ...LONGITUDINAL_TABLES,
  ];
  for (const table of tables) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS bachata_writer_fence_${table}_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN ${condition}
        BEGIN
          SELECT RAISE(ABORT, 'Bachata workspace writer lease is stale');
        END;
      `);
    }
  }
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS bachata_writer_fence_catalog_meta_insert
    BEFORE INSERT ON catalog_meta
    WHEN NEW.key <> 'writer_fence' AND ${condition}
    BEGIN
      SELECT RAISE(ABORT, 'Bachata workspace writer lease is stale');
    END;
    CREATE TRIGGER IF NOT EXISTS bachata_writer_fence_catalog_meta_update
    BEFORE UPDATE ON catalog_meta
    WHEN OLD.key <> 'writer_fence' AND NEW.key <> 'writer_fence' AND ${condition}
    BEGIN
      SELECT RAISE(ABORT, 'Bachata workspace writer lease is stale');
    END;
    CREATE TRIGGER IF NOT EXISTS bachata_writer_fence_catalog_meta_delete
    BEFORE DELETE ON catalog_meta
    WHEN OLD.key <> 'writer_fence' AND ${condition}
    BEGIN
      SELECT RAISE(ABORT, 'Bachata workspace writer lease is stale');
    END;
  `);
};

export const createStateCatalog = (
  storageRoot: string,
  options: StateCatalogOptions = {},
): StateCatalog => {
  mkdirSync(storageRoot, { recursive: true });
  const databasePath = path.join(storageRoot, "bachata-state.sqlite");
  const writerFence = options.writerFence;
  const writerFenceValue = writerFence ? serializeWorkspaceWriterFence(writerFence) : undefined;
  const database = openSqliteDatabase(databasePath, (value) => {
    value.function("bachata_writer_fence", () => writerFenceValue ?? "");
    migrate(value);
    if (writerFenceValue !== undefined) {
      withImmediateTransaction(value, () => {
        installWriterFence(value);
        value.prepare(`
          INSERT INTO catalog_meta(key, value) VALUES('writer_fence', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(writerFenceValue);
      });
    }
  });
  const now = options.now ?? (() => new Date());
  const referenceFactory = options.referenceFactory ?? createReference;
  const retention = {
    eventsPerRun: Math.max(1, options.retention?.eventsPerRun ?? 5000),
    outputsPerRun: Math.max(1, options.retention?.outputsPerRun ?? 1000),
    handledInteractionsPerRun: Math.max(1, options.retention?.handledInteractionsPerRun ?? 1000),
    completedAttemptsPerRun: Math.max(1, options.retention?.completedAttemptsPerRun ?? 2000),
  };
  const timestamp = (): string => now().toISOString();

  const pruneRunHistory = (runRef: string): void => {
    database.prepare(`
      DELETE FROM events
      WHERE run_ref = ?
        AND id NOT IN (
          SELECT id FROM events WHERE run_ref = ? ORDER BY id DESC LIMIT ?
        )
    `).run(runRef, runRef, retention.eventsPerRun);
    database.prepare(`
      DELETE FROM structured_outputs
      WHERE run_ref = ?
        AND output_ref NOT IN (
          SELECT output_ref FROM structured_outputs
          WHERE run_ref = ? ORDER BY created_at DESC, output_ref DESC LIMIT ?
        )
    `).run(runRef, runRef, retention.outputsPerRun);
    database.prepare(`
      DELETE FROM interactions
      WHERE run_ref = ?
        AND handled_at IS NOT NULL
        AND interaction_ref NOT IN (
          SELECT interaction_ref FROM interactions
          WHERE run_ref = ? AND handled_at IS NOT NULL
          ORDER BY handled_at DESC, interaction_ref DESC LIMIT ?
        )
    `).run(runRef, runRef, retention.handledInteractionsPerRun);
    database.prepare(`
      DELETE FROM attempts
      WHERE run_ref = ?
        AND completed_at IS NOT NULL
        AND attempt_ref NOT IN (
          SELECT attempt_ref FROM attempts
          WHERE run_ref = ? AND completed_at IS NOT NULL
          ORDER BY completed_at DESC, attempt_ref DESC LIMIT ?
        )
    `).run(runRef, runRef, retention.completedAttemptsPerRun);
  };

  const insertRunRow = (input: Parameters<StateCatalog["createRun"]>[0]): Record<string, unknown> => {
    const createdAt = timestamp();
    return insertReference("R", referenceFactory, (runRef) => {
      database.prepare(`
        INSERT INTO runs(
          run_ref, legacy_conversation_id, title, input_text, pipeline_id,
          pipeline_version, pipeline_hash, pipeline_scope_root, iteration_count, active_iteration,
          working_root, prepared_draft, result_json, recheck_json, parent_conversation_id, orchestration_run_id,
          orchestration_task_id, orchestration_branch, orchestration_base_commit,
          orchestration_paths_json, participants_json, status, unread, archived, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      `).run(
        runRef,
        input.legacyConversationId ?? null,
        input.title,
        input.input ?? "",
        input.pipelineId ?? null,
        input.pipelineVersion ?? null,
        input.pipelineHash ?? null,
        input.pipelineScopeRoot ?? null,
        input.iterationCount ?? 1,
        input.workingRoot ?? null,
        input.preparedDraft ?? null,
        input.terminalResult ? json(input.terminalResult) : null,
        input.latestRecheck ? json(input.latestRecheck) : null,
        input.parentConversationId ?? null,
        input.orchestrationRunId ?? null,
        input.orchestrationTaskId ?? null,
        input.orchestrationBranch ?? null,
        input.orchestrationBaseCommit ?? null,
        json(input.orchestrationPaths ?? []),
        json(input.participants ?? []),
        input.status ?? "draft",
        createdAt,
        createdAt,
      );
      return (database.prepare("SELECT * FROM runs WHERE run_ref = ?").get(runRef) as Record<string, unknown>);
    });
  };

  const normalizedCreateRun: StateCatalog["createRun"] = (input) =>
    runFromRow(insertRunRow(input));

  const upsertRun: StateCatalog["upsertRun"] = (run) => {
    database.prepare(`
      INSERT INTO runs(
        run_ref, legacy_conversation_id, title, input_text, pipeline_id,
        pipeline_version, pipeline_hash, pipeline_scope_root, iteration_count, active_iteration,
        working_root, prepared_draft, result_json, recheck_json, parent_conversation_id, orchestration_run_id,
        orchestration_task_id, orchestration_branch, orchestration_base_commit,
        orchestration_paths_json, participants_json, run_settings_json,
        replay_source_settings_json, status, unread, archived, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_ref) DO UPDATE SET
        legacy_conversation_id = excluded.legacy_conversation_id,
        title = excluded.title,
        input_text = excluded.input_text,
        pipeline_id = excluded.pipeline_id,
        pipeline_version = excluded.pipeline_version,
        pipeline_hash = excluded.pipeline_hash,
        pipeline_scope_root = excluded.pipeline_scope_root,
        iteration_count = excluded.iteration_count,
        active_iteration = excluded.active_iteration,
        working_root = excluded.working_root,
        prepared_draft = excluded.prepared_draft,
        result_json = excluded.result_json,
        recheck_json = excluded.recheck_json,
        parent_conversation_id = excluded.parent_conversation_id,
        orchestration_run_id = excluded.orchestration_run_id,
        orchestration_task_id = excluded.orchestration_task_id,
        orchestration_branch = excluded.orchestration_branch,
        orchestration_base_commit = excluded.orchestration_base_commit,
        orchestration_paths_json = excluded.orchestration_paths_json,
        participants_json = excluded.participants_json,
        run_settings_json = excluded.run_settings_json,
        replay_source_settings_json = excluded.replay_source_settings_json,
        status = excluded.status,
        unread = excluded.unread,
        archived = excluded.archived,
        updated_at = excluded.updated_at
    `).run(
      run.runRef,
      run.legacyConversationId ?? null,
      run.title,
      run.input,
      run.pipelineId ?? null,
      run.pipelineVersion ?? null,
      run.pipelineHash ?? null,
      run.pipelineScopeRoot ?? null,
      run.iterationCount,
      run.activeIteration,
      run.workingRoot ?? null,
      run.preparedDraft ?? null,
      run.terminalResult ? json(run.terminalResult) : null,
      run.latestRecheck ? json(run.latestRecheck) : null,
      run.parentConversationId ?? null,
      run.orchestrationRunId ?? null,
      run.orchestrationTaskId ?? null,
      run.orchestrationBranch ?? null,
      run.orchestrationBaseCommit ?? null,
      json(run.orchestrationPaths ?? []),
      json(run.participants ?? []),
      run.runSettings === undefined ? null : json(run.runSettings),
      run.replaySourceSettings === undefined ? null : json(run.replaySourceSettings),
      run.status,
      run.unread,
      run.archived ? 1 : 0,
      run.createdAt,
      run.updatedAt,
    );
  };


  const setActiveRunRef: StateCatalog["setActiveRunRef"] = (runRef) => {
    if (runRef === undefined) {
      database.prepare("DELETE FROM catalog_meta WHERE key = 'active_run_ref'").run();
      return;
    }
    database.prepare(`
      INSERT INTO catalog_meta(key, value) VALUES('active_run_ref', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(runRef);
  };

  const deleteRun: StateCatalog["deleteRun"] = (runRef) => {
    database.prepare("DELETE FROM runs WHERE run_ref = ?").run(runRef);
  };

  const createIteration: StateCatalog["createIteration"] = (input) =>
    insertReference("I", referenceFactory, (iterationRef) => {
      database.prepare(`
        INSERT INTO iterations(iteration_ref, run_ref, iteration_index, status, repository_commit, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(
        iterationRef,
        input.runRef,
        input.index,
        input.status ?? "pending",
        input.repositoryCommit ?? null,
        timestamp(),
      );
      return iterationRef;
    });

  const updateIteration: StateCatalog["updateIteration"] = (iterationRef, input) => {
    const completion = input.completed === undefined ? null : input.completed ? 1 : 0;
    database.prepare(`
      UPDATE iterations SET status = ?, repository_commit = COALESCE(?, repository_commit),
        completed_at = CASE
          WHEN ? = 1 THEN ?
          WHEN ? = 0 THEN NULL
          ELSE completed_at
        END
      WHERE iteration_ref = ?
    `).run(
      input.status,
      input.repositoryCommit ?? null,
      completion,
      completion === 1 ? timestamp() : null,
      completion,
      iterationRef,
    );
  };

  const createPair: StateCatalog["createPair"] = (input) =>
    insertReference("P", referenceFactory, (pairRef) => {
      database.prepare(`
        INSERT INTO pairs(
          pair_ref, run_ref, iteration_ref, task_id, pipeline_step_id,
          working_root, worktree_path, branch, base_commit, scope_json, status, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pairRef,
        input.runRef,
        input.iterationRef ?? null,
        input.taskId ?? null,
        input.pipelineStepId ?? null,
        input.workingRoot ?? null,
        input.worktreePath ?? null,
        input.branch ?? null,
        input.baseCommit ?? null,
        json(input.scope),
        input.status ?? "pending",
        timestamp(),
      );
      return pairRef;
    });

  const updatePair: StateCatalog["updatePair"] = (pairRef, input) => {
    const completion = input.completed === undefined ? null : input.completed ? 1 : 0;
    const result = database.prepare(`
      UPDATE pairs SET status = ?, completed_at = CASE
        WHEN ? = 1 THEN ?
        WHEN ? = 0 THEN NULL
        ELSE completed_at
      END
      WHERE pair_ref = ?
    `).run(
      input.status,
      completion,
      completion === 1 ? timestamp() : null,
      completion,
      pairRef,
    );
    if (result.changes !== 1) {
      throw new Error(`Unknown Bachata: ${pairRef}`);
    }
  };

  const getPairForIteration: StateCatalog["getPairForIteration"] = (iterationRef) => {
    const row = database.prepare(`
      SELECT pair_ref, status, completed_at
      FROM pairs
      WHERE iteration_ref = ?
      ORDER BY created_at DESC, pair_ref DESC
      LIMIT 1
    `).get(iterationRef) as Record<string, unknown> | undefined;
    return row
      ? {
          pairRef: String(row.pair_ref),
          status: String(row.status),
          completedAt: optionalString(row.completed_at),
        }
      : undefined;
  };

  const createChat: StateCatalog["createChat"] = (input) => {
    const createdAt = timestamp();
    return insertReference("C", referenceFactory, (chatRef) => {
      const chat: ChatCatalogRecord = {
        ...input,
        agentId: input.agentId ?? input.role,
        chatRef,
        createdAt,
        updatedAt: createdAt,
      };
      database.prepare(`
        INSERT INTO chats(
          chat_ref, run_ref, iteration_ref, pair_ref, agent_id, role, provider, adapter,
          provider_session_id, provider_conversation_url, provider_conversation_identity,
          provider_message_cursor, display_title, status, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        chat.chatRef,
        chat.runRef,
        chat.iterationRef ?? null,
        chat.pairRef ?? null,
        chat.agentId,
        chat.role,
        chat.provider,
        chat.adapter,
        chat.providerSessionId ?? null,
        chat.providerConversationUrl ?? null,
        chat.providerConversationIdentity ?? null,
        chat.providerMessageCursor ?? null,
        chat.displayTitle,
        chat.status,
        chat.createdAt,
        chat.updatedAt,
      );
      return chat;
    });
  };

  const upsertChat: StateCatalog["upsertChat"] = (chat) => {
    database.prepare(`
      INSERT INTO chats(
        chat_ref, run_ref, iteration_ref, pair_ref, agent_id, role, provider, adapter,
        provider_session_id, provider_conversation_url, provider_conversation_identity,
        provider_message_cursor, display_title, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_ref) DO UPDATE SET
        iteration_ref = excluded.iteration_ref,
        pair_ref = excluded.pair_ref,
        agent_id = excluded.agent_id,
        role = excluded.role,
        provider = excluded.provider,
        adapter = excluded.adapter,
        provider_session_id = excluded.provider_session_id,
        provider_conversation_url = excluded.provider_conversation_url,
        provider_conversation_identity = excluded.provider_conversation_identity,
        provider_message_cursor = excluded.provider_message_cursor,
        display_title = excluded.display_title,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      chat.chatRef,
      chat.runRef,
      chat.iterationRef ?? null,
      chat.pairRef ?? null,
      chat.agentId,
      chat.role,
      chat.provider,
      chat.adapter,
      chat.providerSessionId ?? null,
      chat.providerConversationUrl ?? null,
      chat.providerConversationIdentity ?? null,
      chat.providerMessageCursor ?? null,
      chat.displayTitle,
      chat.status,
      chat.createdAt,
      chat.updatedAt,
    );
  };

  const ensureStep: StateCatalog["ensureStep"] = (input) => {
    const existing = database.prepare(`
      SELECT step_ref FROM steps
      WHERE run_ref = ? AND iteration_ref IS ? AND pipeline_step_id = ?
    `).get(input.runRef, input.iterationRef ?? null, input.pipelineStepId) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      return String(existing.step_ref);
    }
    return insertReference("S", referenceFactory, (stepRef) => {
      database.prepare(`
        INSERT INTO steps(
          step_ref, run_ref, iteration_ref, pipeline_step_id, name,
          step_index, status, started_at, completed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        stepRef,
        input.runRef,
        input.iterationRef ?? null,
        input.pipelineStepId,
        input.name,
        input.index,
        input.status ?? "pending",
        input.status === "running" ? timestamp() : null,
      );
      return stepRef;
    });
  };

  const updateStep: StateCatalog["updateStep"] = (stepRef, input) => {
    const current = database.prepare(`
      SELECT started_at FROM steps WHERE step_ref = ?
    `).get(stepRef) as Record<string, unknown> | undefined;
    if (!current) {
      throw new Error(`Unknown step: ${stepRef}`);
    }
    const startedAt = optionalString(current.started_at);
    database.prepare(`
      UPDATE steps SET status = ?, started_at = ?, completed_at = ?
      WHERE step_ref = ?
    `).run(
      input.status,
      input.started && !startedAt
        ? timestamp()
        : startedAt ?? null,
      input.completed ? timestamp() : null,
      stepRef,
    );
  };

  const appendEvent: StateCatalog["appendEvent"] = (input) => {
    const result = database.prepare(`
      INSERT INTO events(run_ref, iteration_ref, pair_ref, step_ref, type, status, title, payload_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runRef,
      input.iterationRef ?? null,
      input.pairRef ?? null,
      input.stepRef ?? null,
      input.type,
      input.status ?? null,
      input.title ?? null,
      json(input.payload),
      timestamp(),
    );
    pruneRunHistory(input.runRef);
    return Number(result.lastInsertRowid);
  };

  const saveStructuredOutput: StateCatalog["saveStructuredOutput"] = (input) =>
    insertReference("S", referenceFactory, (outputRef) => {
      database.prepare(`
        INSERT INTO structured_outputs(
          output_ref, run_ref, iteration_ref, step_ref, name, schema_id,
          content_hash, value_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        outputRef,
        input.runRef,
        input.iterationRef ?? null,
        input.stepRef ?? null,
        input.name,
        input.schemaId ?? null,
        input.contentHash,
        json(input.value),
        timestamp(),
      );
      pruneRunHistory(input.runRef);
      return outputRef;
    });

  const createInteraction: StateCatalog["createInteraction"] = (input) => {
    let sourceKey = input.sourceKey;
    if (sourceKey) {
      const baseSourceKey = sourceKey;
      const rows = database.prepare(`
        SELECT * FROM interactions
        WHERE run_ref = ?
          AND (source_key = ? OR substr(source_key, 1, length(?) + 1) = ? || '#')
      `).all(input.runRef, baseSourceKey, baseSourceKey, baseSourceKey) as Record<string, unknown>[];
      const occurrence = (row: Record<string, unknown>): number => {
        const value = String(row.source_key ?? "");
        if (value === baseSourceKey) {
          return 1;
        }
        const suffix = Number(value.slice(baseSourceKey.length + 1));
        return Number.isSafeInteger(suffix) && suffix > 1 ? suffix : 0;
      };
      const latestRow = rows.reduce<Record<string, unknown> | undefined>((current, row) =>
        !current || occurrence(row) > occurrence(current) ? row : current,
      undefined);
      const latest = latestRow ? interactionFromRow(latestRow) : undefined;
      const payloadHash = interactionPayloadHash(input.context);
      if (latest) {
        const latestPayloadHash = interactionPayloadHash(latest.context);
        const samePayload = payloadHash !== undefined && payloadHash === latestPayloadHash;
        if (
          samePayload &&
          (latest.status === "pending" || latest.status === "paused" ||
            (latest.status === "resolved" && latest.handledAt === undefined))
        ) {
          return latest;
        }
        if (latest.status === "pending" || latest.status === "paused") {
          resolveInteraction(latest.interactionRef, "superseded", {
            selected: [],
            freeText: "",
          });
        }
        if (latest.handledAt === undefined) {
          database.prepare(`
            UPDATE interactions SET handled_at = ?
            WHERE interaction_ref = ? AND handled_at IS NULL
          `).run(timestamp(), latest.interactionRef);
        }
        const nextOccurrence = rows.reduce(
          (maximum, row) => Math.max(maximum, occurrence(row)),
          1,
        ) + 1;
        sourceKey = `${baseSourceKey}#${String(nextOccurrence)}`;
      }
    }
    const createdAt = now();
    // `Math.max(0, …)` is not a guard against a value that is merely too large: the sum
    // still leaves the Date range and `toISOString()` throws an opaque RangeError. Refuse
    // the input here, where the caller can be told what was wrong with it.
    if (input.timeoutMs !== undefined && !isSupportedTimeoutMs(input.timeoutMs)) {
      throw new Error(`Interaction timeoutMs ${describeTimeoutBound()}`);
    }
    const deadlineAt = input.timeoutMs === undefined
      ? undefined
      : new Date(createdAt.getTime() + input.timeoutMs).toISOString();
    return insertReference("Q", referenceFactory, (interactionRef) => {
      database.prepare(`
        INSERT INTO interactions(
          interaction_ref, run_ref, step_ref, kind, source_key, prompt,
          options_json, context_json, selected_json, free_text, status,
          created_at, deadline_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, '[]', '', 'pending', ?, ?)
      `).run(
        interactionRef,
        input.runRef,
        input.stepRef ?? null,
        input.kind,
        sourceKey ?? null,
        input.prompt,
        json(input.options ?? []),
        input.context === undefined ? null : json(input.context),
        createdAt.toISOString(),
        deadlineAt ?? null,
      );
      return interactionFromRow(database.prepare("SELECT * FROM interactions WHERE interaction_ref = ?").get(interactionRef) as Record<string, unknown>);
    });
  };

  const getInteraction: StateCatalog["getInteraction"] = (interactionRef) => {
    const row = database.prepare("SELECT * FROM interactions WHERE interaction_ref = ?").get(interactionRef);
    return row ? interactionFromRow(row as Record<string, unknown>) : undefined;
  };

  const replaceChecklistItems: StateCatalog["replaceChecklistItems"] = (
    interactionRef,
    items,
  ) => {
    withImmediateTransaction(database, () => {
      database.prepare("DELETE FROM checklist_items WHERE interaction_ref = ?").run(interactionRef);
      const statement = database.prepare(`
        INSERT INTO checklist_items(
          interaction_ref, issue_id, title, details, dependencies_json,
          paths_json, selected, position
        ) VALUES(?, ?, ?, ?, ?, ?, 0, ?)
      `);
      items.forEach((item, position) => {
        statement.run(
          interactionRef,
          item.issueId,
          item.title,
          item.details,
          json(item.dependencies),
          json(item.paths),
          position,
        );
      });
    });
  };

  const listChecklistItems: StateCatalog["listChecklistItems"] = (interactionRef) =>
    (database.prepare(`
      SELECT * FROM checklist_items
      WHERE interaction_ref = ?
      ORDER BY position, id
    `).all(interactionRef) as Record<string, unknown>[]).map((row) => ({
      issueId: String(row.issue_id),
      title: String(row.title),
      details: String(row.details),
      dependencies: parseJson<string[]>(row.dependencies_json, []),
      paths: parseJson<string[]>(row.paths_json, []),
      selected: Number(row.selected) === 1,
      position: Number(row.position),
    }));

  const updateChecklistSelection: StateCatalog["updateChecklistSelection"] = (
    interactionRef,
    selectedIssueIds,
  ) => {
    const selected = new Set(selectedIssueIds);
    const items = listChecklistItems(interactionRef);
    const statement = database.prepare(`
      UPDATE checklist_items SET selected = ?
      WHERE interaction_ref = ? AND issue_id = ?
    `);
    items.forEach((item) => {
      statement.run(selected.has(item.issueId) ? 1 : 0, interactionRef, item.issueId);
    });
  };

  const updateInteractionDraft: StateCatalog["updateInteractionDraft"] = (interactionRef, input) =>
    withImmediateTransaction(database, () => {
      const current = getInteraction(interactionRef);
      if (!current) {
        throw new Error(`Unknown interaction: ${interactionRef}`);
      }
      if (current.status !== "pending" && current.status !== "paused") {
        throw new Error(`Interaction ${interactionRef} is already resolved`);
      }
      let status = current.status;
      let deadlineAt = current.deadlineAt;
      let remainingMs = current.remainingMs;
      let pauseReason = current.pauseReason;
      const engaged = input.selected !== undefined || input.freeText !== undefined;
      if (engaged && current.status === "pending") {
        remainingMs = current.deadlineAt
          ? Math.max(0, Date.parse(current.deadlineAt) - now().getTime())
          : undefined;
        deadlineAt = undefined;
        status = "paused";
        pauseReason = input.pauseReason ?? "userEngaged";
      }
      database.prepare(`
        UPDATE interactions SET selected_json = ?, free_text = ?, status = ?,
          deadline_at = ?, remaining_ms = ?, pause_reason = ?
        WHERE interaction_ref = ?
      `).run(
        json(input.selected ?? current.selected),
        input.freeText ?? current.freeText,
        status,
        deadlineAt ?? null,
        remainingMs ?? null,
        pauseReason ?? null,
        interactionRef,
      );
      if (current.kind === "executionChecklist" && input.selected !== undefined) {
        updateChecklistSelection(interactionRef, input.selected);
      }
      return getInteraction(interactionRef) as InteractionRecord;
    });

  const pauseInteraction: StateCatalog["pauseInteraction"] = (interactionRef, reason) => {
    const current = getInteraction(interactionRef);
    if (!current) {
      throw new Error(`Unknown interaction: ${interactionRef}`);
    }
    if (current.status === "paused") {
      return current;
    }
    if (current.status !== "pending") {
      throw new Error(`Interaction ${interactionRef} is already resolved`);
    }
    const remainingMs = current.deadlineAt
      ? Math.max(0, Date.parse(current.deadlineAt) - now().getTime())
      : undefined;
    database.prepare(`
      UPDATE interactions SET status = 'paused', deadline_at = NULL,
        remaining_ms = ?, pause_reason = ?
      WHERE interaction_ref = ? AND status = 'pending'
    `).run(remainingMs ?? null, reason, interactionRef);
    return getInteraction(interactionRef) as InteractionRecord;
  };

  const resumeInteraction: StateCatalog["resumeInteraction"] = (interactionRef) => {
    const current = getInteraction(interactionRef);
    if (!current) {
      throw new Error(`Unknown interaction: ${interactionRef}`);
    }
    if (current.status !== "paused") {
      throw new Error(`Interaction ${interactionRef} is not paused`);
    }
    const deadlineAt = current.remainingMs === undefined
      ? undefined
      : new Date(now().getTime() + current.remainingMs).toISOString();
    database.prepare(`
      UPDATE interactions SET status = 'pending', deadline_at = ?,
        remaining_ms = NULL, pause_reason = NULL
      WHERE interaction_ref = ? AND status = 'paused'
    `).run(deadlineAt ?? null, interactionRef);
    return getInteraction(interactionRef) as InteractionRecord;
  };

  const resolveInteraction: StateCatalog["resolveInteraction"] = (interactionRef, source, resolution) => {
    const result = database.prepare(`
      UPDATE interactions SET status = 'resolved', resolution_source = ?,
        resolution_json = ?, resolved_at = ?, deadline_at = NULL, remaining_ms = NULL
      WHERE interaction_ref = ? AND status IN ('pending', 'paused')
    `).run(source, json(resolution), timestamp(), interactionRef);
    if (result.changes === 1) {
      const interaction = getInteraction(interactionRef);
      if (interaction?.kind === "executionChecklist" && isRecord(resolution) && Array.isArray(resolution.selected)) {
        updateChecklistSelection(
          interactionRef,
          resolution.selected.filter((value): value is string => typeof value === "string"),
        );
      }
    }
    return result.changes === 1;
  };

  const resolveDueInteractions: StateCatalog["resolveDueInteractions"] = () => {
    const due = database.prepare(`
      SELECT * FROM interactions
      WHERE status = 'pending' AND deadline_at IS NOT NULL AND deadline_at <= ?
      ORDER BY deadline_at, interaction_ref
    `).all(timestamp()) as Record<string, unknown>[];
    const resolved: InteractionRecord[] = [];
    for (const row of due) {
      const interaction = interactionFromRow(row);
      const optionIds = interaction.options.flatMap((option) =>
        option !== null &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        typeof (option as Record<string, unknown>).id === "string"
          ? [String((option as Record<string, unknown>).id)]
          : [],
      );
      const resolution = interaction.kind === "executionChecklist"
        ? { selected: [], freeText: interaction.freeText }
        : {
            selected: optionIds.filter((id) => id === "cancel" || id === "reject").slice(0, 1),
            freeText: "",
            fallback: true,
          };
      if (resolveInteraction(interaction.interactionRef, "timeout", resolution)) {
        resolved.push(getInteraction(interaction.interactionRef) as InteractionRecord);
      }
    }
    return resolved;
  };

  const overrideTimedOutInteraction: StateCatalog["overrideTimedOutInteraction"] = (
    interactionRef,
    source,
    resolution,
  ) => {
    const result = database.prepare(`
      UPDATE interactions
      SET resolution_source = ?, resolution_json = ?
      WHERE interaction_ref = ?
        AND status = 'resolved'
        AND resolution_source = 'timeout'
        AND handled_at IS NULL
    `).run(source, json(resolution), interactionRef);
    if (result.changes !== 1) {
      throw new Error(`Interaction ${interactionRef} cannot be overridden`);
    }
    return getInteraction(interactionRef) as InteractionRecord;
  };

  const catalog: StateCatalog = {
    path: databasePath,
    close: () => database.close(),
    longitudinal: createLongitudinalStore(database, options.assertWritable),
    createRun: normalizedCreateRun,
    upsertRun,
    commitRuns: (runs, deletedRunRefs, activeRunRef) => {
      withImmediateTransaction(database, () => {
        runs.forEach(upsertRun);
        deletedRunRefs.forEach(deleteRun);
        setActiveRunRef(activeRunRef);
      });
    },
    getRun: (runRef) => readCatalogRun(database, runRef),
    listRuns: (includeArchived = false) => readCatalogRuns(database, includeArchived),
    deleteRun,
    getActiveRunRef: () => readCatalogActiveRunRef(database),
    setActiveRunRef,
    createIteration,
    updateIteration,
    listIterations: (runRef) => (database.prepare(`
      SELECT * FROM iterations WHERE run_ref = ? ORDER BY iteration_index
    `).all(runRef) as Record<string, unknown>[]).map((row) => ({
      iterationRef: String(row.iteration_ref),
      index: Number(row.iteration_index),
      status: String(row.status),
      repositoryCommit: optionalString(row.repository_commit),
      createdAt: String(row.created_at),
      completedAt: optionalString(row.completed_at),
    })),
    createPair,
    updatePair,
    getPairForIteration,
    createChat,
    upsertChat,
    listChats: (runRef) => (database.prepare(
      "SELECT * FROM chats WHERE run_ref = ? ORDER BY created_at, chat_ref",
    ).all(runRef) as Record<string, unknown>[]).map(chatFromRow),
    ensureStep,
    updateStep,
    appendEvent,
    latestExecutionRef: (runRef) => {
      const row = database.prepare(`
        SELECT id FROM events WHERE run_ref = ? AND type = 'run.started' ORDER BY id DESC LIMIT 1
      `).get(runRef) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : `E${String(row.id)}`;
    },
    listEvents: (runRef, limit = 500) => readCatalogEvents(database, runRef, limit),
    saveStructuredOutput,
    listStructuredOutputs: (runRef) => (database.prepare(`
      SELECT output_ref, name, schema_id, content_hash, value_json, created_at
      FROM structured_outputs WHERE run_ref = ? ORDER BY created_at, output_ref
    `).all(runRef) as Record<string, unknown>[]).map((row) => ({
      outputRef: String(row.output_ref),
      name: String(row.name),
      schemaId: optionalString(row.schema_id),
      contentHash: String(row.content_hash),
      value: parseJson(row.value_json, undefined),
      createdAt: String(row.created_at),
    })),
    createInteraction,
    getInteraction,
    replaceChecklistItems,
    listChecklistItems,
    updateChecklistSelection,
    listOpenInteractions: (runRef) => {
      const rows = runRef
        ? database.prepare(`
            SELECT * FROM interactions WHERE run_ref = ? AND status IN ('pending', 'paused')
            ORDER BY created_at, interaction_ref
          `).all(runRef)
        : database.prepare(`
            SELECT * FROM interactions WHERE status IN ('pending', 'paused')
            ORDER BY created_at, interaction_ref
          `).all();
      return (rows as Record<string, unknown>[]).map(interactionFromRow);
    },
    listInteractions: (runRef) => (database.prepare(`
      SELECT * FROM interactions WHERE run_ref = ? ORDER BY created_at, interaction_ref
    `).all(runRef) as Record<string, unknown>[]).map(interactionFromRow),
    updateInteractionDraft,
    pauseInteraction,
    resumeInteraction,
    resolveInteraction,
    resolveDueInteractions,
    overrideTimedOutInteraction,
    listUnhandledTimeouts: () => (database.prepare(`
      SELECT * FROM interactions
      WHERE status = 'resolved' AND resolution_source = 'timeout' AND handled_at IS NULL
      ORDER BY resolved_at, interaction_ref
    `).all() as Record<string, unknown>[]).map(interactionFromRow),
    markInteractionHandled: (interactionRef) => {
      database.prepare(`
        UPDATE interactions SET handled_at = ?
        WHERE interaction_ref = ? AND status = 'resolved' AND handled_at IS NULL
      `).run(timestamp(), interactionRef);
      const interaction = getInteraction(interactionRef);
      if (interaction) {
        pruneRunHistory(interaction.runRef);
      }
    },
    nextDeadlineAt: () => optionalString((database.prepare(`
      SELECT MIN(deadline_at) AS deadline_at
      FROM interactions WHERE status = 'pending' AND deadline_at IS NOT NULL
    `).get() as Record<string, unknown>).deadline_at),
  };
  if (!options.assertWritable) {
    return catalog;
  }
  const mutationMethods = new Set<keyof StateCatalog>([
    "createRun",
    "upsertRun",
    "commitRuns",
    "deleteRun",
    "setActiveRunRef",
    "createIteration",
    "updateIteration",
    "createPair",
    "updatePair",
    "createChat",
    "upsertChat",
    "ensureStep",
    "updateStep",
    "appendEvent",
    "saveStructuredOutput",
    "createInteraction",
    "replaceChecklistItems",
    "updateChecklistSelection",
    "updateInteractionDraft",
    "pauseInteraction",
    "resumeInteraction",
    "resolveInteraction",
    "resolveDueInteractions",
    "overrideTimedOutInteraction",
    "markInteractionHandled",
  ]);
  return new Proxy(catalog, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof property !== "string" ||
        !mutationMethods.has(property as keyof StateCatalog) ||
        typeof value !== "function"
      ) {
        return value;
      }
      return (...args: unknown[]) => {
        options.assertWritable?.();
        return (value as (...parameters: unknown[]) => unknown)(...args);
      };
    },
  }) as StateCatalog;
};
