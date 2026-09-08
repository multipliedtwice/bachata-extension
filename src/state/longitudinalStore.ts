import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "./sqlite";
import {
  parseCycle,
  parseDecisionRecord,
  parseFindingHistoryEntry,
  parseInitiative,
  parseExternalEvidenceRecord,
  parseInitiativeArtifact,
  parseLongitudinalRound,
  parseRunCycleBinding,
} from "../longitudinal/parse";
import { EMPTY_LONGITUDINAL_SNAPSHOT } from "../longitudinal/types";
import type {
  Cycle,
  FindingAlias,
  FindingFixRun,
  DecisionRecord,
  FindingHistoryEntry,
  Initiative,
  ExternalEvidenceRecord,
  InitiativeArtifact,
  LongitudinalRound,
  LongitudinalSnapshot,
  RunCycleBinding,
} from "../longitudinal/types";

export const LONGITUDINAL_TABLES = [
  "initiatives",
  "cycles",
  "cycle_runs",
  "initiative_artifacts",
  "initiative_decisions",
  "finding_history",
  "longitudinal_rounds",
  "run_cycle_bindings",
  "finding_aliases",
  "finding_fix_runs",
  "repository_active_initiative",
  "initiative_external_evidence",
];

export const migrateLongitudinal = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS initiatives (
      initiative_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS initiatives_repository_idx
      ON initiatives(repository_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS cycles (
      cycle_id TEXT PRIMARY KEY,
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cycles_sequence_idx
      ON cycles(initiative_id, sequence);

    CREATE TABLE IF NOT EXISTS cycle_runs (
      cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id) ON DELETE CASCADE,
      run_ref TEXT NOT NULL,
      PRIMARY KEY (cycle_id, run_ref)
    );
    CREATE INDEX IF NOT EXISTS cycle_runs_run_idx ON cycle_runs(run_ref);

    CREATE TABLE IF NOT EXISTS initiative_artifacts (
      artifact_id TEXT PRIMARY KEY,
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      cycle_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS initiative_artifacts_initiative_idx
      ON initiative_artifacts(initiative_id, updated_at);

    CREATE TABLE IF NOT EXISTS initiative_decisions (
      decision_id TEXT PRIMARY KEY,
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      cycle_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS initiative_decisions_subject_idx
      ON initiative_decisions(initiative_id, subject);

    CREATE TABLE IF NOT EXISTS finding_history (
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (initiative_id, identity)
    );
  `);
};

const decisionsAreInitiativeScoped = (database: DatabaseSync): boolean =>
  database.prepare("PRAGMA index_list(initiative_decisions)").all()
    .some((row) => {
      const record = row as Record<string, unknown>;
      if (record.origin !== "pk") return false;
      const columns = database
        .prepare(`PRAGMA index_info(${JSON.stringify(String(record.name))})`)
        .all()
        .map((entry) => String((entry as Record<string, unknown>).name));
      return columns.includes("initiative_id") && columns.includes("decision_id");
    });

export const migrateLongitudinalRounds = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS longitudinal_rounds (
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      cycle_id TEXT NOT NULL,
      run_ref TEXT NOT NULL,
      execution_ref TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      PRIMARY KEY (initiative_id, cycle_id, run_ref, execution_ref)
    );
    CREATE INDEX IF NOT EXISTS longitudinal_rounds_cycle_idx
      ON longitudinal_rounds(initiative_id, cycle_id, recorded_at);

    CREATE TABLE IF NOT EXISTS run_cycle_bindings (
      run_ref TEXT PRIMARY KEY,
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      cycle_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      bound_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_cycle_bindings_cycle_idx
      ON run_cycle_bindings(initiative_id, cycle_id);
  `);
  if (decisionsAreInitiativeScoped(database)) return;
  database.exec(`
    CREATE TABLE initiative_decisions_scoped (
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      decision_id TEXT NOT NULL,
      cycle_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (initiative_id, decision_id)
    );
    INSERT OR IGNORE INTO initiative_decisions_scoped
      (initiative_id, decision_id, cycle_id, subject, document_json, updated_at)
      SELECT initiative_id, decision_id, cycle_id, subject, document_json, updated_at
      FROM initiative_decisions;
    DROP TABLE initiative_decisions;
    ALTER TABLE initiative_decisions_scoped RENAME TO initiative_decisions;
    CREATE INDEX IF NOT EXISTS initiative_decisions_subject_idx
      ON initiative_decisions(initiative_id, subject);
  `);
};

export const migrateFindingAliases = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS finding_aliases (
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      alias_identity TEXT NOT NULL,
      canonical_identity TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (initiative_id, alias_identity)
    );
    CREATE INDEX IF NOT EXISTS finding_aliases_canonical_idx
      ON finding_aliases(initiative_id, canonical_identity);
  `);
};

export const migrateFindingFixRuns = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS finding_fix_runs (
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      run_ref TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (initiative_id, identity, run_ref)
    );
    CREATE INDEX IF NOT EXISTS finding_fix_runs_run_idx
      ON finding_fix_runs(initiative_id, run_ref);
  `);
};

export const migrateFixRunProvenance = (database: DatabaseSync): void => {
  const columns = new Set(
    database.prepare("PRAGMA table_info(finding_fix_runs)").all()
      .map((row) => String((row as Record<string, unknown>).name)),
  );
  if (columns.has("imported")) return;
  database.exec(
    "ALTER TABLE finding_fix_runs ADD COLUMN imported INTEGER NOT NULL DEFAULT 0",
  );
};

export const migrateExternalEvidence = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS initiative_external_evidence (
      evidence_id TEXT PRIMARY KEY,
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      cycle_id TEXT NOT NULL,
      logical_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS initiative_external_evidence_initiative_idx
      ON initiative_external_evidence(initiative_id, updated_at);
    CREATE INDEX IF NOT EXISTS initiative_external_evidence_logical_idx
      ON initiative_external_evidence(initiative_id, logical_id);
  `);
};

export const migrateActiveInitiative = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS repository_active_initiative (
      repository_id TEXT PRIMARY KEY,
      initiative_id TEXT NOT NULL REFERENCES initiatives(initiative_id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL
    );
  `);
};

export type LongitudinalStore = {
  listInitiatives: () => Initiative[];
  listInitiativesByRepository: (repositoryId: string) => Initiative[];
  getInitiative: (initiativeId: string) => Initiative | undefined;
  findInitiativeByRepository: (repositoryId: string) => Initiative | undefined;
  activeInitiativeId: (repositoryId: string) => string | undefined;
  setActiveInitiative: (repositoryId: string, initiativeId: string) => void;
  importInitiative: (input: {
    initiative: Initiative;
    cycles: readonly Cycle[];
    artifacts: readonly InitiativeArtifact[];
    decisions: readonly DecisionRecord[];
    findings: readonly FindingHistoryEntry[];
    rounds: readonly LongitudinalRound[];
    aliases: readonly FindingAlias[];
    fixRuns: readonly FindingFixRun[];
    externalEvidence?: readonly ExternalEvidenceRecord[];
  }) => void;
  saveInitiative: (initiative: Initiative) => void;
  deleteInitiative: (initiativeId: string) => void;
  listCycles: (initiativeId: string) => Cycle[];
  saveCycle: (cycle: Cycle) => void;
  cycleForRun: (runRef: string) => Cycle | undefined;
  listArtifacts: (initiativeId: string) => InitiativeArtifact[];
  saveArtifacts: (artifacts: readonly InitiativeArtifact[]) => void;
  listExternalEvidence: (initiativeId: string) => ExternalEvidenceRecord[];
  // One write, so a superseded predecessor and its replacement can never land separately.
  commitExternalEvidence: (records: readonly ExternalEvidenceRecord[]) => void;
  listDecisions: (initiativeId: string) => DecisionRecord[];
  saveDecisions: (decisions: readonly DecisionRecord[]) => void;
  listFindingHistory: (initiativeId: string) => FindingHistoryEntry[];
  saveFindingHistory: (entries: readonly FindingHistoryEntry[]) => void;
  listFindingAliases: (initiativeId: string) => FindingAlias[];
  commitFindingMerge: (input: {
    alias: FindingAlias;
    canonical: FindingHistoryEntry;
    absorbedIdentity: string;
    absorbedFixRuns: readonly FindingFixRun[];
  }) => void;
  removeFindingAlias: (initiativeId: string, aliasIdentity: string) => boolean;
  listFixRuns: (initiativeId: string) => FindingFixRun[];
  fixRunsForRun: (runRef: string) => FindingFixRun[];
  commitFixRunState: (input: {
    fixRuns: readonly FindingFixRun[];
    findings: readonly FindingHistoryEntry[];
    artifacts?: readonly InitiativeArtifact[];
    cycle?: Cycle;
  }) => void;
  listRounds: (initiativeId: string, cycleId?: string) => LongitudinalRound[];
  bindRun: (binding: RunCycleBinding) => void;
  runBinding: (runRef: string) => RunCycleBinding | undefined;
  commitRunBinding: (input: {
    binding: RunCycleBinding;
    cycle: Cycle;
  }) => void;
  commitCycleStart: (input: {
    initiative: Initiative;
    previous?: Cycle;
    cycle: Cycle;
  }) => void;
  commitResolution: (input: {
    findings?: readonly FindingHistoryEntry[];
    decisions?: readonly DecisionRecord[];
    artifacts?: readonly InitiativeArtifact[];
    cycle?: Cycle;
  }) => void;
  commitRound: (input: {
    round: LongitudinalRound;
    history: readonly FindingHistoryEntry[];
    decisions: readonly DecisionRecord[];
    artifacts: readonly InitiativeArtifact[];
    aliases?: readonly FindingAlias[];
    cycle: Cycle;
  }) => boolean;
  snapshot: (initiativeId: string | undefined) => LongitudinalSnapshot;
};

const documents = (rows: unknown[]): unknown[] =>
  rows.map((row) => {
    const record = row as Record<string, unknown>;
    return JSON.parse(String(record.document_json)) as unknown;
  });

export const createLongitudinalStore = (
  database: DatabaseSync,
  assertWritable?: () => void,
): LongitudinalStore => {
  const write = (operation: () => void): void => {
    assertWritable?.();
    withImmediateTransaction(database, operation);
  };

  const listInitiatives = (): Initiative[] =>
    documents(
      database.prepare("SELECT document_json FROM initiatives ORDER BY updated_at DESC").all(),
    ).flatMap((value) => {
      const initiative = parseInitiative(value);
      return initiative === undefined ? [] : [initiative];
    });

  const getInitiative = (initiativeId: string): Initiative | undefined => {
    const row = database
      .prepare("SELECT document_json FROM initiatives WHERE initiative_id = ?")
      .get(initiativeId);
    return row === undefined ? undefined : parseInitiative(documents([row])[0]);
  };

  const listCycles = (initiativeId: string): Cycle[] =>
    documents(
      database
        .prepare("SELECT document_json FROM cycles WHERE initiative_id = ? ORDER BY sequence ASC")
        .all(initiativeId),
    ).flatMap((value) => {
      const cycle = parseCycle(value);
      return cycle === undefined ? [] : [cycle];
    });

  const listArtifacts = (initiativeId: string): InitiativeArtifact[] =>
    documents(
      database
        .prepare(
          "SELECT document_json FROM initiative_artifacts WHERE initiative_id = ? ORDER BY updated_at ASC, artifact_id ASC",
        )
        .all(initiativeId),
    ).flatMap((value) => {
      const artifact = parseInitiativeArtifact(value);
      return artifact === undefined ? [] : [artifact];
    });

  const listExternalEvidence = (initiativeId: string): ExternalEvidenceRecord[] =>
    documents(
      database
        .prepare(
          "SELECT document_json FROM initiative_external_evidence WHERE initiative_id = ? ORDER BY updated_at ASC, evidence_id ASC",
        )
        .all(initiativeId),
    ).flatMap((value) => {
      const record = parseExternalEvidenceRecord(value);
      return record === undefined ? [] : [record];
    });

  const listDecisions = (initiativeId: string): DecisionRecord[] =>
    documents(
      database
        .prepare(
          "SELECT document_json FROM initiative_decisions WHERE initiative_id = ? ORDER BY updated_at ASC, decision_id ASC",
        )
        .all(initiativeId),
    ).flatMap((value) => {
      const decision = parseDecisionRecord(value);
      return decision === undefined ? [] : [decision];
    });

  const listFindingHistory = (initiativeId: string): FindingHistoryEntry[] =>
    documents(
      database
        .prepare(
          "SELECT document_json FROM finding_history WHERE initiative_id = ? ORDER BY updated_at ASC, identity ASC",
        )
        .all(initiativeId),
    ).flatMap((value) => {
      const entry = parseFindingHistoryEntry(value);
      return entry === undefined ? [] : [entry];
    });

  const listFindingAliases = (initiativeId: string): FindingAlias[] =>
    database
      .prepare(
        "SELECT alias_identity, canonical_identity, reason, created_by, created_at FROM finding_aliases WHERE initiative_id = ? ORDER BY created_at ASC, alias_identity ASC",
      )
      .all(initiativeId)
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          initiativeId,
          aliasIdentity: String(record.alias_identity),
          canonicalIdentity: String(record.canonical_identity),
          reason: String(record.reason),
          createdBy: String(record.created_by),
          createdAt: String(record.created_at),
        };
      });

  const listFixRuns = (initiativeId: string): FindingFixRun[] =>
    database
      .prepare(
        "SELECT identity, run_ref, state, imported, updated_at FROM finding_fix_runs WHERE initiative_id = ? ORDER BY updated_at ASC, identity ASC, run_ref ASC",
      )
      .all(initiativeId)
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          initiativeId,
          identity: String(record.identity),
          runRef: String(record.run_ref),
          state: String(record.state) as FindingFixRun["state"],
          ...(Number(record.imported) === 1 ? { imported: true } : {}),
          updatedAt: String(record.updated_at),
        };
      });

  const listRounds = (initiativeId: string, cycleId?: string): LongitudinalRound[] =>
    documents(
      cycleId === undefined
        ? database
            .prepare(
              "SELECT document_json FROM longitudinal_rounds WHERE initiative_id = ? ORDER BY recorded_at ASC, run_ref ASC, execution_ref ASC",
            )
            .all(initiativeId)
        : database
            .prepare(
              "SELECT document_json FROM longitudinal_rounds WHERE initiative_id = ? AND cycle_id = ? ORDER BY recorded_at ASC, run_ref ASC, execution_ref ASC",
            )
            .all(initiativeId, cycleId),
    ).flatMap((value) => {
      const round = parseLongitudinalRound(value);
      return round === undefined ? [] : [round];
    });

  const writeFindingHistory = (entries: readonly FindingHistoryEntry[]): void => {
    entries.forEach((entry) => {
      database
        .prepare(`
          INSERT INTO finding_history(initiative_id, identity, document_json, updated_at)
          VALUES(?, ?, ?, ?)
          ON CONFLICT(initiative_id, identity) DO UPDATE SET
            document_json = excluded.document_json,
            updated_at = excluded.updated_at
        `)
        .run(entry.initiativeId, entry.identity, JSON.stringify(entry), entry.lastSeenAt);
    });
  };

  const writeFindingAliases = (aliases: readonly FindingAlias[]): void => {
    aliases.forEach((alias) => {
      database
        .prepare(`
          INSERT INTO finding_aliases
            (initiative_id, alias_identity, canonical_identity, reason, created_by, created_at)
          VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(initiative_id, alias_identity) DO NOTHING
        `)
        .run(
          alias.initiativeId,
          alias.aliasIdentity,
          alias.canonicalIdentity,
          alias.reason,
          alias.createdBy,
          alias.createdAt,
        );
    });
  };

  const writeDecisions = (decisions: readonly DecisionRecord[]): void => {
    decisions.forEach((decision) => {
      database
        .prepare(`
          INSERT INTO initiative_decisions(initiative_id, decision_id, cycle_id, subject, document_json, updated_at)
          VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(initiative_id, decision_id) DO UPDATE SET
            cycle_id = excluded.cycle_id,
            subject = excluded.subject,
            document_json = excluded.document_json,
            updated_at = excluded.updated_at
        `)
        .run(
          decision.initiativeId,
          decision.id,
          decision.cycleId,
          decision.subject,
          JSON.stringify(decision),
          decision.updatedAt,
        );
    });
  };

  const writeRunBinding = (binding: RunCycleBinding): void => {
    database
      .prepare(`
        INSERT INTO run_cycle_bindings(run_ref, initiative_id, cycle_id, document_json, bound_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(run_ref) DO UPDATE SET
          initiative_id = excluded.initiative_id,
          cycle_id = excluded.cycle_id,
          document_json = excluded.document_json,
          bound_at = excluded.bound_at
      `)
      .run(
        binding.runRef,
        binding.initiativeId,
        binding.cycleId,
        JSON.stringify(binding),
        binding.boundAt,
      );
  };

  const writeInitiative = (initiative: Initiative): void => {
    database
      .prepare(`
        INSERT INTO initiatives(initiative_id, repository_id, document_json, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(initiative_id) DO UPDATE SET
          repository_id = excluded.repository_id,
          document_json = excluded.document_json,
          updated_at = excluded.updated_at
      `)
      .run(
        initiative.id,
        initiative.repositoryId,
        JSON.stringify(initiative),
        initiative.updatedAt,
      );
  };

  const writeExternalEvidence = (records: readonly ExternalEvidenceRecord[]): void => {
    records.forEach((record) => {
      database
        .prepare(`
          INSERT INTO initiative_external_evidence(
            evidence_id, initiative_id, cycle_id, logical_id, document_json, updated_at
          )
          VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(evidence_id) DO UPDATE SET
            cycle_id = excluded.cycle_id,
            logical_id = excluded.logical_id,
            document_json = excluded.document_json,
            updated_at = excluded.updated_at
        `)
        .run(
          record.id,
          record.initiativeId,
          record.cycleId,
          record.logicalId,
          JSON.stringify(record),
          record.updatedAt,
        );
    });
  };

  const writeArtifacts = (artifacts: readonly InitiativeArtifact[]): void => {
    artifacts.forEach((artifact) => {
      database
        .prepare(`
          INSERT INTO initiative_artifacts(artifact_id, initiative_id, cycle_id, document_json, updated_at)
          VALUES(?, ?, ?, ?, ?)
          ON CONFLICT(artifact_id) DO UPDATE SET
            cycle_id = excluded.cycle_id,
            document_json = excluded.document_json,
            updated_at = excluded.updated_at
        `)
        .run(
          artifact.id,
          artifact.initiativeId,
          artifact.cycleId,
          JSON.stringify(artifact),
          artifact.updatedAt,
        );
    });
  };

  const writeCycle = (cycle: Cycle): void => {
    database
      .prepare(`
        INSERT INTO cycles(cycle_id, initiative_id, sequence, document_json, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(cycle_id) DO UPDATE SET
          sequence = excluded.sequence,
          document_json = excluded.document_json,
          updated_at = excluded.updated_at
      `)
      .run(cycle.id, cycle.initiativeId, cycle.sequence, JSON.stringify(cycle), cycle.updatedAt);
    database.prepare("DELETE FROM cycle_runs WHERE cycle_id = ?").run(cycle.id);
    cycle.runRefs.forEach((runRef) => {
      database
        .prepare("INSERT OR IGNORE INTO cycle_runs(cycle_id, run_ref) VALUES(?, ?)")
        .run(cycle.id, runRef);
    });
  };

  const writeRound = (round: LongitudinalRound): void => {
    database
      .prepare(`
        INSERT INTO longitudinal_rounds
          (initiative_id, cycle_id, run_ref, execution_ref, recorded_at, document_json)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(initiative_id, cycle_id, run_ref, execution_ref) DO NOTHING
      `)
      .run(
        round.initiativeId,
        round.cycleId,
        round.runRef,
        round.executionRef,
        round.recordedAt,
        JSON.stringify(round),
      );
  };

  return {
    listInitiatives,
    listInitiativesByRepository: (repositoryId) =>
      documents(
        database
          .prepare(
            "SELECT document_json FROM initiatives WHERE repository_id = ? ORDER BY updated_at DESC",
          )
          .all(repositoryId),
      ).flatMap((value) => {
        const initiative = parseInitiative(value);
        return initiative === undefined ? [] : [initiative];
      }),
    activeInitiativeId: (repositoryId) => {
      const row = database
        .prepare("SELECT initiative_id FROM repository_active_initiative WHERE repository_id = ?")
        .get(repositoryId);
      return row === undefined
        ? undefined
        : String((row as Record<string, unknown>).initiative_id);
    },
    setActiveInitiative: (repositoryId, initiativeId) => {
      write(() => {
        database
          .prepare(`
            INSERT INTO repository_active_initiative(repository_id, initiative_id, updated_at)
            VALUES(?, ?, ?)
            ON CONFLICT(repository_id) DO UPDATE SET
              initiative_id = excluded.initiative_id,
              updated_at = excluded.updated_at
          `)
          .run(repositoryId, initiativeId, new Date().toISOString());
      });
    },
    importInitiative: (input) => {
      write(() => {
        writeInitiative(input.initiative);
        input.cycles.forEach(writeCycle);
        writeArtifacts(input.artifacts);
        writeDecisions(input.decisions);
        writeFindingHistory(input.findings);
        input.rounds.forEach(writeRound);
        input.fixRuns.forEach((fixRun) => {
          database
            .prepare(`
              INSERT INTO finding_fix_runs(initiative_id, identity, run_ref, state, imported, updated_at)
              VALUES(?, ?, ?, ?, 1, ?)
              ON CONFLICT(initiative_id, identity, run_ref) DO NOTHING
            `)
            .run(
              fixRun.initiativeId,
              fixRun.identity,
              fixRun.runRef,
              fixRun.state,
              fixRun.updatedAt,
            );
        });
        writeFindingAliases(input.aliases);
        writeExternalEvidence(input.externalEvidence ?? []);
      });
    },
    getInitiative,
    findInitiativeByRepository: (repositoryId) => {
      const row = database
        .prepare(
          "SELECT document_json FROM initiatives WHERE repository_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(repositoryId);
      return row === undefined ? undefined : parseInitiative(documents([row])[0]);
    },
    saveInitiative: (initiative) => {
      write(() => writeInitiative(initiative));
    },
    deleteInitiative: (initiativeId) => {
      write(() => {
        database.prepare("DELETE FROM initiatives WHERE initiative_id = ?").run(initiativeId);
      });
    },
    listCycles,
    saveCycle: (cycle) => {
      write(() => writeCycle(cycle));
    },
    cycleForRun: (runRef) => {
      const row = database
        .prepare(`
          SELECT cycles.document_json AS document_json
          FROM cycle_runs
          JOIN cycles ON cycles.cycle_id = cycle_runs.cycle_id
          WHERE cycle_runs.run_ref = ?
          ORDER BY cycles.sequence DESC
          LIMIT 1
        `)
        .get(runRef);
      return row === undefined ? undefined : parseCycle(documents([row])[0]);
    },
    listArtifacts,
    saveArtifacts: (artifacts) => {
      if (artifacts.length === 0) return;
      write(() => writeArtifacts(artifacts));
    },
    listExternalEvidence,
    commitExternalEvidence: (records) => {
      if (records.length === 0) return;
      write(() => writeExternalEvidence(records));
    },
    listDecisions,
    saveDecisions: (decisions) => {
      if (decisions.length === 0) return;
      write(() => writeDecisions(decisions));
    },
    listFindingHistory,
    saveFindingHistory: (entries) => {
      if (entries.length === 0) return;
      write(() => writeFindingHistory(entries));
    },
    listFindingAliases,
    commitFindingMerge: (input) => {
      write(() => {
        database
          .prepare(`
            INSERT INTO finding_aliases
              (initiative_id, alias_identity, canonical_identity, reason, created_by, created_at)
            VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT(initiative_id, alias_identity) DO UPDATE SET
              canonical_identity = excluded.canonical_identity,
              reason = excluded.reason,
              created_by = excluded.created_by,
              created_at = excluded.created_at
          `)
          .run(
            input.alias.initiativeId,
            input.alias.aliasIdentity,
            input.alias.canonicalIdentity,
            input.alias.reason,
            input.alias.createdBy,
            input.alias.createdAt,
          );
        database
          .prepare("UPDATE finding_aliases SET canonical_identity = ? WHERE initiative_id = ? AND canonical_identity = ?")
          .run(
            input.alias.canonicalIdentity,
            input.alias.initiativeId,
            input.alias.aliasIdentity,
          );
        writeFindingHistory([input.canonical]);
        input.absorbedFixRuns.forEach((fixRun) => {
          database
            .prepare(`
              INSERT INTO finding_fix_runs(initiative_id, identity, run_ref, state, imported, updated_at)
              VALUES(?, ?, ?, ?, ?, ?)
              ON CONFLICT(initiative_id, identity, run_ref) DO UPDATE SET
                state = excluded.state,
                imported = MIN(finding_fix_runs.imported, excluded.imported),
                updated_at = excluded.updated_at
            `)
            .run(
              input.canonical.initiativeId,
              input.canonical.identity,
              fixRun.runRef,
              fixRun.state,
              fixRun.imported === true ? 1 : 0,
              fixRun.updatedAt,
            );
        });
        database
          .prepare("DELETE FROM finding_fix_runs WHERE initiative_id = ? AND identity = ?")
          .run(input.canonical.initiativeId, input.absorbedIdentity);
        database
          .prepare("DELETE FROM finding_history WHERE initiative_id = ? AND identity = ?")
          .run(input.canonical.initiativeId, input.absorbedIdentity);
      });
    },
    removeFindingAlias: (initiativeId, aliasIdentity) => {
      let removed = false;
      write(() => {
        const result = database
          .prepare("DELETE FROM finding_aliases WHERE initiative_id = ? AND alias_identity = ?")
          .run(initiativeId, aliasIdentity);
        removed = Number(result.changes) === 1;
      });
      return removed;
    },
    listFixRuns,
    fixRunsForRun: (runRef) =>
      database
        .prepare(
          "SELECT initiative_id, identity, run_ref, state, imported, updated_at FROM finding_fix_runs WHERE run_ref = ? ORDER BY identity ASC",
        )
        .all(runRef)
        .map((row) => {
          const record = row as Record<string, unknown>;
          return {
            initiativeId: String(record.initiative_id),
            identity: String(record.identity),
            runRef: String(record.run_ref),
            state: String(record.state) as FindingFixRun["state"],
            ...(Number(record.imported) === 1 ? { imported: true } : {}),
            updatedAt: String(record.updated_at),
          };
        }),
    commitFixRunState: (input) => {
      if (
        input.fixRuns.length === 0 &&
        input.findings.length === 0 &&
        (input.artifacts ?? []).length === 0 &&
        input.cycle === undefined
      ) return;
      write(() => {
        input.fixRuns.forEach((fixRun) => {
          database
            .prepare(`
              INSERT INTO finding_fix_runs(initiative_id, identity, run_ref, state, imported, updated_at)
              VALUES(?, ?, ?, ?, ?, ?)
              ON CONFLICT(initiative_id, identity, run_ref) DO UPDATE SET
                state = excluded.state,
                imported = MIN(finding_fix_runs.imported, excluded.imported),
                updated_at = excluded.updated_at
            `)
            .run(
              fixRun.initiativeId,
              fixRun.identity,
              fixRun.runRef,
              fixRun.state,
              fixRun.imported === true ? 1 : 0,
              fixRun.updatedAt,
            );
        });
        writeFindingHistory(input.findings);
        writeArtifacts(input.artifacts ?? []);
        if (input.cycle !== undefined) writeCycle(input.cycle);
      });
    },
    listRounds,
    bindRun: (binding) => {
      write(() => writeRunBinding(binding));
    },
    runBinding: (runRef) => {
      const row = database
        .prepare("SELECT document_json FROM run_cycle_bindings WHERE run_ref = ?")
        .get(runRef);
      return row === undefined ? undefined : parseRunCycleBinding(documents([row])[0]);
    },
    commitRunBinding: (input) => {
      write(() => {
        writeRunBinding(input.binding);
        writeCycle(input.cycle);
      });
    },
    commitCycleStart: (input) => {
      write(() => {
        if (input.previous !== undefined) writeCycle(input.previous);
        writeCycle(input.cycle);
        writeInitiative(input.initiative);
      });
    },
    commitResolution: (input) => {
      write(() => {
        writeFindingHistory(input.findings ?? []);
        writeDecisions(input.decisions ?? []);
        writeArtifacts(input.artifacts ?? []);
        if (input.cycle !== undefined) writeCycle(input.cycle);
      });
    },
    commitRound: (input) => {
      let applied = false;
      write(() => {
        const result = database
          .prepare(`
            INSERT INTO longitudinal_rounds
              (initiative_id, cycle_id, run_ref, execution_ref, recorded_at, document_json)
            VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT(initiative_id, cycle_id, run_ref, execution_ref) DO NOTHING
          `)
          .run(
            input.round.initiativeId,
            input.round.cycleId,
            input.round.runRef,
            input.round.executionRef,
            input.round.recordedAt,
            JSON.stringify(input.round),
          );
        if (Number(result.changes) !== 1) return;
        writeFindingHistory(input.history);
        writeDecisions(input.decisions);
        writeArtifacts(input.artifacts);
        writeFindingAliases(input.aliases ?? []);
        writeCycle(input.cycle);
        applied = true;
      });
      return applied;
    },
    snapshot: (initiativeId) => {
      if (initiativeId === undefined) return EMPTY_LONGITUDINAL_SNAPSHOT;
      const initiative = getInitiative(initiativeId);
      if (initiative === undefined) return EMPTY_LONGITUDINAL_SNAPSHOT;
      return {
        initiative,
        cycles: listCycles(initiativeId),
        artifacts: listArtifacts(initiativeId),
        decisions: listDecisions(initiativeId),
        findings: listFindingHistory(initiativeId),
        findingAliases: listFindingAliases(initiativeId),
        fixRuns: listFixRuns(initiativeId),
      };
    },
  };
};
