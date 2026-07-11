import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpointDigest,
  createSignedCheckpoint,
  verifyCheckpointChain
} from "../../src/security/audit-checkpoint.js";
import {
  CREDENTIAL_ACCOUNTS,
  MemoryCredentialStore
} from "../../src/security/credential-store.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { RuntimeAuthority } from "../../src/daemon/authority.js";

const STORE_PASSPHRASE = "checkpoint store passphrase for tests";

async function appendEvent(store: EncryptedEventStore, version: number): Promise<void> {
  await store.append({
    aggregateType: "career-twin",
    aggregateId: "LOCAL-CHECKPOINT-TEST",
    eventType: version === 1 ? "created" : "updated",
    schemaVersion: 1,
    payload: { version },
    occurredAt: new Date(`2026-07-11T12:0${version}:00.000Z`)
  });
}

describe("signed audit checkpoints", () => {
  let dir: string;
  let databasePath: string;
  let credentialStore: MemoryCredentialStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vocation-checkpoint-"));
    databasePath = path.join(dir, "vocation.db");
    credentialStore = new MemoryCredentialStore();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates an Ed25519 checkpoint whose signature and external digest verify", async () => {
    const store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 1);

    const checkpoint = await createSignedCheckpoint(
      store,
      credentialStore,
      new Date("2026-07-11T13:00:00.000Z"),
      "CHK-SIGNATURE-VERIFICATION"
    );
    const verification = await verifyCheckpointChain(store, credentialStore);

    expect(checkpoint.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(checkpoint.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verification).toEqual({
      valid: true,
      checkpointCount: 1,
      latestDigest: checkpointDigest(checkpoint),
      externalDigestMatched: true
    });
    expect(await credentialStore.get(CREDENTIAL_ACCOUNTS.latestCheckpointDigest)).toBe(
      checkpointDigest(checkpoint)
    );
    await store.close();
  });

  it("rejects a database checkpoint that differs from the externally retained latest digest", async () => {
    const store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 1);
    await createSignedCheckpoint(store, credentialStore, new Date("2026-07-11T13:01:00.000Z"), "CHK-DIGEST");
    await credentialStore.set(
      CREDENTIAL_ACCOUNTS.latestCheckpointDigest,
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    );

    await expect(verifyCheckpointChain(store, credentialStore)).rejects.toThrow(
      "Database checkpoint does not match the latest digest retained in the credential store"
    );
    await store.close();
  });

  it("blocks authority health and mutation while the external checkpoint anchor is inconsistent", async () => {
    const store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 1);
    await createSignedCheckpoint(store, credentialStore, new Date("2026-07-11T13:01:00.000Z"), "CHK-GATE");
    await credentialStore.set(
      CREDENTIAL_ACCOUNTS.latestCheckpointDigest,
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    );
    const authority = new RuntimeAuthority(store, credentialStore, dir);

    await expect(authority.execute({
      id: "REQ-CHECKPOINT-GATE-HEALTH",
      operation: "health",
      payload: {}
    })).rejects.toThrow("does not match the latest digest");
    await expect(authority.execute({
      id: "REQ-CHECKPOINT-GATE-KILL",
      operation: "auto-apply-kill",
      payload: { reason: "must not write" }
    })).rejects.toThrow("does not match the latest digest");
    expect((await store.chainHead()).eventCount).toBe(1);
    await store.close();
  });

  it("detects rollback to an older complete database image", async () => {
    const olderDatabasePath = path.join(dir, "older.db");
    let store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 1);
    await createSignedCheckpoint(store, credentialStore, new Date("2026-07-11T13:02:00.000Z"), "CHK-OLDER");
    await store.close();
    copyFileSync(databasePath, olderDatabasePath);

    store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 2);
    await createSignedCheckpoint(store, credentialStore, new Date("2026-07-11T13:03:00.000Z"), "CHK-LATEST");
    await store.close();

    copyFileSync(olderDatabasePath, databasePath);
    const rolledBack = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await expect(verifyCheckpointChain(rolledBack, credentialStore)).rejects.toThrow(
      "Database checkpoint does not match the latest digest retained in the credential store"
    );
    await rolledBack.close();
  });

  it("detects deletion of the latest checkpoint row", async () => {
    const store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 1);
    await createSignedCheckpoint(store, credentialStore, new Date("2026-07-11T13:04:00.000Z"), "CHK-FIRST");
    await appendEvent(store, 2);
    await createSignedCheckpoint(store, credentialStore, new Date("2026-07-11T13:05:00.000Z"), "CHK-SECOND");
    await store.close();

    const sqlite = new BetterSqlite3(databasePath);
    sqlite.prepare("DELETE FROM signed_checkpoints WHERE checkpoint_id = ?").run("CHK-SECOND");
    sqlite.close();

    const reopened = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await expect(verifyCheckpointChain(reopened, credentialStore)).rejects.toThrow(
      "Database checkpoint does not match the latest digest retained in the credential store"
    );
    await reopened.close();
  });

  it("rejects a checkpoint with a tampered signature", async () => {
    const store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 1);
    await createSignedCheckpoint(store, credentialStore, new Date("2026-07-11T13:06:00.000Z"), "CHK-TAMPERED");
    await store.close();

    const sqlite = new BetterSqlite3(databasePath);
    const row = sqlite.prepare(
      "SELECT signature FROM signed_checkpoints WHERE checkpoint_id = ?"
    ).get("CHK-TAMPERED") as { signature: string };
    const signature = Buffer.from(row.signature, "base64url");
    signature[0] = (signature[0] ?? 0) ^ 1;
    sqlite.prepare("UPDATE signed_checkpoints SET signature = ? WHERE checkpoint_id = ?").run(
      signature.toString("base64url"),
      "CHK-TAMPERED"
    );
    sqlite.close();

    const reopened = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await expect(verifyCheckpointChain(reopened, credentialStore)).rejects.toThrow(
      "Checkpoint signature is invalid at CHK-TAMPERED"
    );
    await reopened.close();
  });

  it("returns the original checkpoint for a deterministic replay id", async () => {
    const store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 1);
    const checkpointId = "CHK-DETERMINISTIC-REPLAY";
    const first = await createSignedCheckpoint(
      store,
      credentialStore,
      new Date("2026-07-11T13:07:00.000Z"),
      checkpointId
    );
    const replay = await createSignedCheckpoint(
      store,
      credentialStore,
      new Date("2026-07-11T13:08:00.000Z"),
      checkpointId
    );

    expect(replay).toEqual(first);
    expect(store.listSignedCheckpoints()).toEqual([first]);
    await store.close();
  });

  it("rejects a new checkpoint when the event chain has not advanced", async () => {
    const store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    await appendEvent(store, 1);
    await createSignedCheckpoint(store, credentialStore, new Date("2026-07-11T13:09:00.000Z"), "CHK-BASELINE");

    await expect(
      createSignedCheckpoint(
        store,
        credentialStore,
        new Date("2026-07-11T13:10:00.000Z"),
        "CHK-NO-ADVANCEMENT"
      )
    ).rejects.toThrow("Checkpoint requires event chain advancement");
    expect(store.listSignedCheckpoints()).toHaveLength(1);
    await store.close();
  });
});
