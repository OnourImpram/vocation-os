import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEncryptedBackup, restoreEncryptedBackup } from "../../src/storage/encrypted-backup.js";
import { EncryptedEventStore, type StoredEvent } from "../../src/storage/encrypted-event-store.js";
import { readOperationJournal } from "../../src/storage/operation-journal.js";

const STORE_PASSPHRASE = "store passphrase for backup tests";
const BACKUP_PASSPHRASE = "backup passphrase for restore tests";

interface TestPayload {
  marker: string;
  sequence: number;
}

async function populateStore(
  databasePath: string,
  marker: string,
  passphrase = STORE_PASSPHRASE
): Promise<{
  store: EncryptedEventStore;
  events: StoredEvent<TestPayload>[];
}> {
  const store = await EncryptedEventStore.open(databasePath, passphrase);
  await store.append<TestPayload>({
    aggregateType: "career-twin",
    aggregateId: "LOCAL-BACKUP-TEST",
    eventType: "created",
    schemaVersion: 1,
    payload: { marker, sequence: 1 },
    occurredAt: new Date("2026-07-11T08:00:00.000Z")
  });
  await store.append<TestPayload>({
    aggregateType: "career-twin",
    aggregateId: "LOCAL-BACKUP-TEST",
    eventType: "updated",
    schemaVersion: 1,
    payload: { marker, sequence: 2 },
    occurredAt: new Date("2026-07-11T08:01:00.000Z")
  });
  return { store, events: await store.readAll<TestPayload>() };
}

describe("encrypted backup and restore", () => {
  let dir: string;
  let sourcePath: string;
  let backupPath: string;
  let targetPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vocation-backup-"));
    sourcePath = path.join(dir, "source.db");
    backupPath = path.join(dir, "source.vocationbak");
    targetPath = path.join(dir, "restored.db");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the manifest and database only inside the encrypted envelope", async () => {
    const privateMarker = "private-career-payload-that-must-not-leak";
    const { store } = await populateStore(sourcePath, privateMarker);
    const manifest = await createEncryptedBackup(store, backupPath, BACKUP_PASSPHRASE, {
      now: new Date("2026-07-11T09:00:00.000Z")
    });
    await store.close();

    const rawBackup = readFileSync(backupPath, "utf8");
    const envelope = JSON.parse(rawBackup) as Record<string, unknown>;

    expect(rawBackup).not.toContain(privateMarker);
    expect(rawBackup).not.toContain(manifest.databaseId);
    expect(rawBackup).not.toContain(manifest.eventChainHead);
    expect(envelope).not.toHaveProperty("manifest");
    expect(envelope).not.toHaveProperty("database");
    expect(Object.keys(envelope).sort()).toEqual([
      "cipher",
      "ciphertext",
      "format",
      "kdf",
      "nonce",
      "salt",
      "tag",
      "version"
    ]);
    expect(envelope.ciphertext).toEqual(expect.any(String));
  });

  it("rejects a wrong backup passphrase without creating a restore target", async () => {
    const { store } = await populateStore(sourcePath, "wrong-passphrase-source");
    await createEncryptedBackup(store, backupPath, BACKUP_PASSPHRASE);
    await store.close();

    await expect(
      restoreEncryptedBackup({
        backupPath,
        backupPassphrase: "incorrect backup passphrase",
        databasePath: targetPath,
        storePassphrase: STORE_PASSPHRASE
      })
    ).rejects.toThrow("Encrypted backup cannot be authenticated with the supplied passphrase");
    expect(existsSync(targetPath)).toBe(false);
  });

  it("restores a verified backup into a new target", async () => {
    const { store, events } = await populateStore(sourcePath, "new-target-source");
    const manifest = await createEncryptedBackup(store, backupPath, BACKUP_PASSPHRASE);
    await store.close();

    const result = await restoreEncryptedBackup({
      backupPath,
      backupPassphrase: BACKUP_PASSPHRASE,
      databasePath: targetPath,
      storePassphrase: STORE_PASSPHRASE,
      now: new Date("2026-07-11T10:00:00.000Z")
    });

    expect(result.rollbackPath).toBeNull();
    expect(result.databaseId).toBe(manifest.databaseId);
    expect(result.eventCount).toBe(events.length);
    expect(readOperationJournal(result.journalPath)?.phase).toBe("complete");

    const restored = await EncryptedEventStore.open(targetPath, STORE_PASSPHRASE);
    expect(await restored.readAll<TestPayload>()).toHaveLength(events.length);
    await restored.close();
  });

  it("cleans staged database artifacts when pre-swap verification fails", async () => {
    const { store } = await populateStore(sourcePath, "staging-cleanup-source");
    await createEncryptedBackup(store, backupPath, BACKUP_PASSPHRASE);
    await store.close();
    const journalPath = path.join(dir, "failed-staging-journal.json");

    await expect(restoreEncryptedBackup({
      backupPath,
      backupPassphrase: BACKUP_PASSPHRASE,
      databasePath: targetPath,
      storePassphrase: "incorrect store passphrase",
      journalPath
    })).rejects.toThrow("Unable to unlock");

    expect(existsSync(targetPath)).toBe(false);
    expect(readOperationJournal(journalPath)?.phase).toBe("rolled_back");
    expect(readdirSync(dir).some((file) => file.includes(".staging"))).toBe(false);
  });

  it("requires explicit approval before replacing an existing target", async () => {
    const { store: source } = await populateStore(sourcePath, "replacement-source");
    await createEncryptedBackup(source, backupPath, BACKUP_PASSPHRASE);
    await source.close();

    const { store: existing } = await populateStore(targetPath, "existing-target");
    await existing.close();
    const originalDatabase = readFileSync(targetPath);

    await expect(
      restoreEncryptedBackup({
        backupPath,
        backupPassphrase: BACKUP_PASSPHRASE,
        databasePath: targetPath,
        storePassphrase: STORE_PASSPHRASE
      })
    ).rejects.toThrow("Explicit replacement approval is required");
    expect(readFileSync(targetPath)).toEqual(originalDatabase);
  });

  it("rolls back to the existing database when post-swap verification fails", async () => {
    const { store: source } = await populateStore(sourcePath, "replacement-source");
    await createEncryptedBackup(source, backupPath, BACKUP_PASSPHRASE);
    await source.close();

    const { store: existing, events: existingEvents } = await populateStore(targetPath, "existing-target");
    await existing.close();
    const journalPath = path.join(dir, "restore-journal.json");
    const originalOpen = EncryptedEventStore.open.bind(EncryptedEventStore);
    let restoreOpenCount = 0;
    vi.spyOn(EncryptedEventStore, "open").mockImplementation(async (databasePath, passphrase) => {
      restoreOpenCount += 1;
      if (restoreOpenCount === 2) throw new Error("simulated post-swap verification failure");
      return originalOpen(databasePath, passphrase);
    });

    await expect(
      restoreEncryptedBackup({
        backupPath,
        backupPassphrase: BACKUP_PASSPHRASE,
        databasePath: targetPath,
        storePassphrase: STORE_PASSPHRASE,
        replaceExisting: true,
        journalPath,
        now: new Date("2026-07-11T11:00:00.000Z")
      })
    ).rejects.toThrow("simulated post-swap verification failure");

    vi.restoreAllMocks();
    expect(readOperationJournal(journalPath)?.phase).toBe("rolled_back");
    const rolledBack = await EncryptedEventStore.open(targetPath, STORE_PASSPHRASE);
    expect(await rolledBack.readAll<TestPayload>()).toEqual(existingEvents);
    await rolledBack.close();
  });

  it("rejects a tampered encrypted envelope", async () => {
    const { store } = await populateStore(sourcePath, "tamper-source");
    await createEncryptedBackup(store, backupPath, BACKUP_PASSPHRASE);
    await store.close();

    const envelope = JSON.parse(readFileSync(backupPath, "utf8")) as { ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    envelope.ciphertext = ciphertext.toString("base64url");
    writeFileSync(backupPath, `${JSON.stringify(envelope)}\n`, "utf8");

    await expect(
      restoreEncryptedBackup({
        backupPath,
        backupPassphrase: BACKUP_PASSPHRASE,
        databasePath: targetPath,
        storePassphrase: STORE_PASSPHRASE
      })
    ).rejects.toThrow("Encrypted backup cannot be authenticated with the supplied passphrase");
    expect(existsSync(targetPath)).toBe(false);
  });

  it("preserves the complete event chain across backup and restore", async () => {
    const { store, events: sourceEvents } = await populateStore(sourcePath, "chain-source");
    const sourceHead = await store.chainHead();
    const sourceDatabaseId = await store.databaseId();
    await createEncryptedBackup(store, backupPath, BACKUP_PASSPHRASE);
    await store.close();

    await restoreEncryptedBackup({
      backupPath,
      backupPassphrase: BACKUP_PASSPHRASE,
      databasePath: targetPath,
      storePassphrase: STORE_PASSPHRASE
    });

    const restored = await EncryptedEventStore.open(targetPath, STORE_PASSPHRASE);
    expect(await restored.readAll<TestPayload>()).toEqual(sourceEvents);
    expect(await restored.chainHead()).toEqual(sourceHead);
    expect(await restored.databaseId()).toBe(sourceDatabaseId);
    await restored.close();
  });
});
