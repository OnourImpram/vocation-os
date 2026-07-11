import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverInterruptedRestore } from "../../src/storage/encrypted-backup.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { readOperationJournal, writeOperationJournal } from "../../src/storage/operation-journal.js";

const PASSPHRASE = "storage recovery test passphrase";

async function createStore(filePath: string, marker: string): Promise<void> {
  const store = await EncryptedEventStore.open(filePath, PASSPHRASE);
  await store.append({
    aggregateType: "recovery-test",
    aggregateId: "RECOVERY-001",
    eventType: "created",
    schemaVersion: 1,
    payload: { marker }
  });
  await store.close();
}

async function readMarker(filePath: string): Promise<string> {
  const store = await EncryptedEventStore.open(filePath, PASSPHRASE);
  try {
    return (await store.readAll<{ marker: string }>())[0]!.payload.marker;
  } finally {
    await store.close();
  }
}

describe("interrupted restore recovery", () => {
  let dir: string;
  let databasePath: string;
  let stagingPath: string;
  let rollbackPath: string;
  let journalPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vocation-storage-recovery-"));
    databasePath = path.join(dir, "vocation.db");
    stagingPath = path.join(dir, "vocation.db.staging");
    rollbackPath = path.join(dir, "vocation.db.rollback");
    journalPath = path.join(dir, "vocation.db.restore-journal.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores the rollback image when the canonical path disappeared before staging promotion", async () => {
    await createStore(databasePath, "original");
    await createStore(stagingPath, "replacement");
    renameSync(databasePath, rollbackPath);
    writeOperationJournal(journalPath, {
      version: 1,
      operationId: "RESTORE-RECOVERY-001",
      operation: "restore",
      phase: "backup_complete",
      targetPath: databasePath,
      stagingPath,
      rollbackPath,
      updatedAt: "2026-07-11T00:00:00.000Z"
    });

    await expect(recoverInterruptedRestore({
      journalPath,
      databasePath,
      storePassphrase: PASSPHRASE
    })).resolves.toEqual({ recovered: true, outcome: "rolled_back" });
    expect(await readMarker(databasePath)).toBe("original");
    expect(existsSync(stagingPath)).toBe(false);
    expect(readOperationJournal(journalPath)?.phase).toBe("rolled_back");
  });

  it("completes recovery when staging was promoted before the journal advanced", async () => {
    await createStore(databasePath, "replacement");
    await createStore(rollbackPath, "original");
    writeOperationJournal(journalPath, {
      version: 1,
      operationId: "RESTORE-RECOVERY-002",
      operation: "restore",
      phase: "backup_complete",
      targetPath: databasePath,
      stagingPath,
      rollbackPath,
      updatedAt: "2026-07-11T00:00:00.000Z"
    });

    await expect(recoverInterruptedRestore({
      journalPath,
      databasePath,
      storePassphrase: PASSPHRASE
    })).resolves.toEqual({ recovered: true, outcome: "complete" });
    expect(await readMarker(databasePath)).toBe("replacement");
    expect(readOperationJournal(journalPath)?.phase).toBe("complete");
  });

  it("fails closed when an interrupted restore has no recoverable image", async () => {
    writeOperationJournal(journalPath, {
      version: 1,
      operationId: "RESTORE-RECOVERY-003",
      operation: "restore",
      phase: "staged",
      targetPath: databasePath,
      stagingPath,
      rollbackPath,
      updatedAt: "2026-07-11T00:00:00.000Z"
    });

    await expect(recoverInterruptedRestore({
      journalPath,
      databasePath,
      storePassphrase: PASSPHRASE
    })).rejects.toThrow("ambiguous");
    expect(existsSync(databasePath)).toBe(false);
  });
});
