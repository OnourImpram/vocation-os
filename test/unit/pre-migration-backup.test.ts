import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectEncryptedBackup, restoreEncryptedBackup } from "../../src/storage/encrypted-backup.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";

const PASSPHRASE = "correct horse battery staple";

describe("automatic pre migration backup", () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vocation-pre-migration-"));
    databasePath = path.join(dir, "vocation.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a restorable encrypted backup before adopting a v0.3 store", async () => {
    const initial = await EncryptedEventStore.open(databasePath, PASSPHRASE);
    await initial.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-MIGRATION-001",
      eventType: "created",
      schemaVersion: 1,
      payload: { sentinel: "migration-sensitive-value" }
    });
    await initial.close();

    const sqlite = new BetterSqlite3(databasePath);
    sqlite.exec(`
      DROP TABLE signed_checkpoints;
      DROP TABLE authority_receipts;
      DROP TABLE legacy_import_receipts;
      DROP TABLE schema_migrations;
      DELETE FROM metadata WHERE key = 'database_id';
    `);
    sqlite.close();

    const migrated = await EncryptedEventStore.open(databasePath, PASSPHRASE);
    const databaseId = await migrated.databaseId();
    expect(migrated.migrations().map((migration) => migration.version)).toEqual([1, 2]);
    await migrated.close();

    const backupDir = path.join(dir, "backups");
    const backupFiles = readdirSync(backupDir).filter((file) => file.endsWith(".vocationbak"));
    expect(backupFiles).toHaveLength(1);
    const backupPath = path.join(backupDir, backupFiles[0]!);
    expect(readFileSync(backupPath, "utf8")).not.toContain("migration-sensitive-value");
    expect(inspectEncryptedBackup(backupPath, PASSPHRASE)).toMatchObject({
      databaseId,
      eventCount: 1,
      migrationVersions: [1]
    });

    const restoredPath = path.join(dir, "restored.db");
    await restoreEncryptedBackup({
      backupPath,
      backupPassphrase: PASSPHRASE,
      databasePath: restoredPath,
      storePassphrase: PASSPHRASE
    });
    const restored = await EncryptedEventStore.open(restoredPath, PASSPHRASE);
    expect(await restored.databaseId()).toBe(databaseId);
    expect((await restored.readAll<{ sentinel: string }>())[0]?.payload.sentinel).toBe("migration-sensitive-value");
    expect(restored.migrations().map((migration) => migration.version)).toEqual([1, 2]);
    await restored.close();
  });
});
