import type BetterSqlite3 from "better-sqlite3";
import { sha256 } from "../hash.js";

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
  checksum: string;
}

interface MigrationDefinition {
  version: number;
  name: string;
  sql: string;
}

interface ColumnContract {
  name: string;
  type: "INTEGER" | "TEXT";
  notnull: 0 | 1;
  pk: number;
}

const CORE_TABLE_COLUMNS: Record<string, readonly ColumnContract[]> = {
  metadata: [
    { name: "key", type: "TEXT", notnull: 0, pk: 1 },
    { name: "value", type: "TEXT", notnull: 1, pk: 0 }
  ],
  events: [
    { name: "sequence", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "event_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "aggregate_type", type: "TEXT", notnull: 1, pk: 0 },
    { name: "aggregate_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "event_type", type: "TEXT", notnull: 1, pk: 0 },
    { name: "schema_version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "occurred_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload_ciphertext", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload_nonce", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload_tag", type: "TEXT", notnull: 1, pk: 0 },
    { name: "previous_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "event_hash", type: "TEXT", notnull: 1, pk: 0 }
  ],
  snapshots: [
    { name: "aggregate_type", type: "TEXT", notnull: 1, pk: 1 },
    { name: "aggregate_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "last_event_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload_ciphertext", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload_nonce", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload_tag", type: "TEXT", notnull: 1, pk: 0 }
  ]
} as const;

const MIGRATION_TABLE_COLUMNS: Record<string, readonly ColumnContract[]> = {
  schema_migrations: [
    { name: "version", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "applied_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "checksum", type: "TEXT", notnull: 1, pk: 0 }
  ]
};

const VERSION_TWO_TABLE_COLUMNS: Record<string, readonly ColumnContract[]> = {
  legacy_import_receipts: [
    { name: "source_digest", type: "TEXT", notnull: 0, pk: 1 },
    { name: "source_kind", type: "TEXT", notnull: 1, pk: 0 },
    { name: "source_locator_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "event_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "imported_at", type: "TEXT", notnull: 1, pk: 0 }
  ],
  authority_receipts: [
    { name: "request_id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "request_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "operation", type: "TEXT", notnull: 1, pk: 0 },
    { name: "event_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "response_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "completed_at", type: "TEXT", notnull: 1, pk: 0 }
  ],
  signed_checkpoints: [
    { name: "checkpoint_id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "database_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "schema_version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "event_count", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "head_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "device_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "key_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "previous_checkpoint_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "public_key_pem", type: "TEXT", notnull: 1, pk: 0 },
    { name: "signature", type: "TEXT", notnull: 1, pk: 0 }
  ]
};

const MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    name: "encrypted-event-store-foundation",
    sql: `
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        payload_nonce TEXT NOT NULL,
        payload_tag TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE
      );
      CREATE INDEX idx_events_aggregate ON events(aggregate_type, aggregate_id, sequence);
      CREATE TABLE snapshots (
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_event_hash TEXT NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        payload_nonce TEXT NOT NULL,
        payload_tag TEXT NOT NULL,
        PRIMARY KEY (aggregate_type, aggregate_id)
      );
    `
  },
  {
    version: 2,
    name: "runtime-authority-foundation",
    sql: `
      CREATE TABLE legacy_import_receipts (
        source_digest TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_locator_hash TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE authority_receipts (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        event_id TEXT,
        response_hash TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE TABLE signed_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        database_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        head_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        device_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        previous_checkpoint_digest TEXT NOT NULL,
        public_key_pem TEXT NOT NULL,
        signature TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_signed_checkpoints_head
        ON signed_checkpoints(event_count, head_hash, device_id);
    `
  }
];

function migrationChecksum(migration: MigrationDefinition): string {
  return sha256(`${migration.version}:${migration.name}:${migration.sql.trim().replace(/\r\n/g, "\n")}`);
}

function tableExists(sqlite: BetterSqlite3.Database, tableName: string): boolean {
  const row = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function tableColumns(sqlite: BetterSqlite3.Database, tableName: string): ColumnContract[] {
  return (sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>).map((row) => ({
    name: row.name,
    type: row.type.toUpperCase() as ColumnContract["type"],
    notnull: row.notnull as ColumnContract["notnull"],
    pk: row.pk
  }));
}

function indexColumnSets(sqlite: BetterSqlite3.Database, tableName: string, uniqueOnly: boolean): string[][] {
  const indexes = sqlite.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{
    name: string;
    unique: number;
  }>;
  return indexes
    .filter((index) => !uniqueOnly || index.unique === 1)
    .map((index) => (sqlite.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{
      seqno: number;
      name: string;
    }>).sort((left, right) => left.seqno - right.seqno).map((column) => column.name));
}

function assertLegacyCoreSchema(sqlite: BetterSqlite3.Database): void {
  const tableNames = Object.keys(CORE_TABLE_COLUMNS);
  const existing = tableNames.filter((tableName) => tableExists(sqlite, tableName));
  if (existing.length === 0) return;
  if (existing.length !== tableNames.length) {
    throw new Error("Legacy encrypted store schema is partial and cannot be adopted safely");
  }
  for (const [tableName, requiredColumns] of Object.entries(CORE_TABLE_COLUMNS)) {
    const actual = tableColumns(sqlite, tableName);
    if (JSON.stringify(actual) !== JSON.stringify(requiredColumns)) {
      throw new Error(`Legacy encrypted store table ${tableName} does not match the trusted column contract`);
    }
  }
  const tableSql = sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'"
  ).get() as { sql?: string } | undefined;
  if (!tableSql?.sql || !/AUTOINCREMENT/i.test(tableSql.sql)) {
    throw new Error("Legacy encrypted store events table is missing AUTOINCREMENT");
  }
  const uniqueEventIndexes = indexColumnSets(sqlite, "events", true)
    .map((columns) => columns.join(","));
  if (!uniqueEventIndexes.includes("event_id") || !uniqueEventIndexes.includes("event_hash")) {
    throw new Error("Legacy encrypted store events table is missing trusted unique indexes");
  }
  const aggregateIndex = indexColumnSets(sqlite, "events", false)
    .some((columns) => columns.join(",") === "aggregate_type,aggregate_id,sequence");
  if (!aggregateIndex) {
    throw new Error("Legacy encrypted store events table is missing the aggregate sequence index");
  }
}

function assertTableContracts(
  sqlite: BetterSqlite3.Database,
  contracts: Record<string, readonly ColumnContract[]>
): void {
  for (const [tableName, contract] of Object.entries(contracts)) {
    if (!tableExists(sqlite, tableName)) throw new Error(`Trusted store table is missing: ${tableName}`);
    if (JSON.stringify(tableColumns(sqlite, tableName)) !== JSON.stringify(contract)) {
      throw new Error(`Trusted store table ${tableName} does not match its column contract`);
    }
  }
}

function assertStoreSchemaForVersion(sqlite: BetterSqlite3.Database, version: number): void {
  if (version < 1) return;
  assertLegacyCoreSchema(sqlite);
  if (!tableExists(sqlite, "metadata")) throw new Error("Trusted encrypted store core tables are missing");
  assertTableContracts(sqlite, MIGRATION_TABLE_COLUMNS);
  if (version < 2) return;
  assertTableContracts(sqlite, VERSION_TWO_TABLE_COLUMNS);
  const importUnique = indexColumnSets(sqlite, "legacy_import_receipts", true)
    .some((columns) => columns.join(",") === "event_id");
  if (!importUnique) throw new Error("Legacy import receipt event id uniqueness is missing");
  const checkpointUnique = indexColumnSets(sqlite, "signed_checkpoints", true)
    .some((columns) => columns.join(",") === "event_count,head_hash,device_id");
  if (!checkpointUnique) throw new Error("Signed checkpoint head uniqueness is missing");
}

function listAppliedRows(sqlite: BetterSqlite3.Database): AppliedMigration[] {
  return (sqlite.prepare(
    "SELECT version, name, applied_at AS appliedAt, checksum FROM schema_migrations ORDER BY version"
  ).all() as AppliedMigration[]);
}

function assertMigrationHistory(applied: readonly AppliedMigration[]): void {
  for (const record of applied) {
    const definition = MIGRATIONS.find((migration) => migration.version === record.version);
    if (!definition) {
      throw new Error(`Database migration ${record.version} is newer than this VocationOS build`);
    }
    if (record.name !== definition.name || record.checksum !== migrationChecksum(definition)) {
      throw new Error(`Database migration ${record.version} checksum does not match the trusted migration`);
    }
  }
}

export function applyStoreMigrations(
  sqlite: BetterSqlite3.Database,
  now = new Date()
): AppliedMigration[] {
  if (!tableExists(sqlite, "schema_migrations")) {
    assertLegacyCoreSchema(sqlite);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);

  let applied = listAppliedRows(sqlite);
  assertMigrationHistory(applied);
  if (applied.length > 0) assertStoreSchemaForVersion(sqlite, applied.at(-1)!.version);

  if (applied.length === 0) {
    const hasLegacyCore = tableExists(sqlite, "metadata");
    if (hasLegacyCore) {
      const foundation = MIGRATIONS[0]!;
      sqlite.prepare(
        "INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)"
      ).run(foundation.version, foundation.name, now.toISOString(), migrationChecksum(foundation));
      applied = listAppliedRows(sqlite);
    }
  }

  const appliedVersions = new Set(applied.map((record) => record.version));
  const applyPending = sqlite.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      sqlite.exec(migration.sql);
      sqlite.prepare(
        "INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)"
      ).run(migration.version, migration.name, now.toISOString(), migrationChecksum(migration));
      appliedVersions.add(migration.version);
    }
  });
  applyPending();

  const result = listAppliedRows(sqlite);
  assertMigrationHistory(result);
  assertStoreSchemaForVersion(sqlite, result.at(-1)?.version ?? 0);
  return result;
}

export function listStoreMigrations(sqlite: BetterSqlite3.Database): AppliedMigration[] {
  if (!tableExists(sqlite, "schema_migrations")) {
    assertLegacyCoreSchema(sqlite);
    return [];
  }
  const applied = listAppliedRows(sqlite);
  assertMigrationHistory(applied);
  assertStoreSchemaForVersion(sqlite, applied.at(-1)?.version ?? 0);
  return applied;
}

export const LATEST_STORE_MIGRATION = MIGRATIONS.at(-1)!.version;
