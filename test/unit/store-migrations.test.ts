import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyStoreMigrations,
  LATEST_STORE_MIGRATION,
  listStoreMigrations
} from "../../src/storage/migrations.js";

function tableNames(sqlite: BetterSqlite3.Database): string[] {
  return (sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

function createLegacyCoreSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
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
  `);
}

describe("store migrations", () => {
  it("applies the complete migration history to a fresh database", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      const appliedAt = new Date("2026-07-11T10:00:00.000Z");
      const migrations = applyStoreMigrations(sqlite, appliedAt);

      expect(migrations.map((migration) => migration.version)).toEqual([1, 2]);
      expect(migrations.at(-1)?.version).toBe(LATEST_STORE_MIGRATION);
      expect(migrations.every((migration) => migration.appliedAt === appliedAt.toISOString())).toBe(true);
      expect(tableNames(sqlite)).toEqual(expect.arrayContaining([
        "schema_migrations",
        "metadata",
        "events",
        "snapshots",
        "legacy_import_receipts",
        "authority_receipts",
        "signed_checkpoints"
      ]));
    } finally {
      sqlite.close();
    }
  });

  it("adopts a complete v0.3 core schema without replacing existing data", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      createLegacyCoreSchema(sqlite);
      sqlite.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("legacy_sentinel", "preserved");

      const migrations = applyStoreMigrations(sqlite, new Date("2026-07-11T11:00:00.000Z"));

      expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
        { version: 1, name: "encrypted-event-store-foundation" },
        { version: 2, name: "runtime-authority-foundation" }
      ]);
      expect(
        (sqlite.prepare("SELECT value FROM metadata WHERE key = ?").get("legacy_sentinel") as { value: string }).value
      ).toBe("preserved");
      expect(tableNames(sqlite)).toContain("legacy_import_receipts");
    } finally {
      sqlite.close();
    }
  });

  it("fails closed when an applied migration checksum is tampered", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      applyStoreMigrations(sqlite);
      sqlite.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(
        `sha256:${"0".repeat(64)}`
      );

      expect(() => listStoreMigrations(sqlite)).toThrow(
        "Database migration 1 checksum does not match the trusted migration"
      );
      expect(() => applyStoreMigrations(sqlite)).toThrow(
        "Database migration 1 checksum does not match the trusted migration"
      );
    } finally {
      sqlite.close();
    }
  });

  it("rejects a partial legacy schema before creating migration history", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      sqlite.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

      expect(() => applyStoreMigrations(sqlite)).toThrow(
        "Legacy encrypted store schema is partial and cannot be adopted safely"
      );
      expect(tableNames(sqlite)).not.toContain("schema_migrations");
    } finally {
      sqlite.close();
    }
  });

  it("rejects a legacy schema with missing trusted indexes", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      createLegacyCoreSchema(sqlite);
      sqlite.exec("DROP INDEX idx_events_aggregate");

      expect(() => applyStoreMigrations(sqlite)).toThrow("missing the aggregate sequence index");
      expect(tableNames(sqlite)).not.toContain("schema_migrations");
    } finally {
      sqlite.close();
    }
  });

  it("detects runtime schema drift even when migration checksums remain valid", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      applyStoreMigrations(sqlite);
      sqlite.exec("DROP TABLE authority_receipts");

      expect(() => listStoreMigrations(sqlite)).toThrow("Trusted store table is missing: authority_receipts");
      expect(() => applyStoreMigrations(sqlite)).toThrow("Trusted store table is missing: authority_receipts");
    } finally {
      sqlite.close();
    }
  });
});
