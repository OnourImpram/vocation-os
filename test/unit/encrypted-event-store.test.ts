import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";

describe("encrypted event store", () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vocation-store-"));
    databasePath = path.join(dir, "vocation.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round trips encrypted events and snapshots", async () => {
    const store = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    const event = await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "claim-added",
      schemaVersion: 1,
      payload: { privateClaim: "sensitive profile value" },
      occurredAt: new Date("2026-07-11T00:00:00.000Z")
    });
    await store.saveSnapshot("career-twin", "LOCAL-001", 1, event.eventHash, { status: "ready" });

    expect((await store.readAggregate<{ privateClaim: string }>("career-twin", "LOCAL-001"))[0]?.payload.privateClaim).toBe(
      "sensitive profile value"
    );
    expect((await store.loadSnapshot<{ status: string }>("career-twin", "LOCAL-001"))?.payload.status).toBe("ready");
    await store.close();

    expect(readFileSync(databasePath).includes(Buffer.from("sensitive profile value", "utf8"))).toBe(false);
  });

  it("rejects the wrong passphrase", async () => {
    const store = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    await store.close();
    await expect(EncryptedEventStore.open(databasePath, "this passphrase is incorrect")).rejects.toThrow("Unable to unlock");
  });

  it("detects ciphertext tampering before returning payload", async () => {
    const store = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "claim-added",
      schemaVersion: 1,
      payload: { value: "private" }
    });
    await store.close();

    const sqlite = new BetterSqlite3(databasePath);
    sqlite.prepare("UPDATE events SET payload_ciphertext = ? WHERE sequence = 1").run("AAAA");
    sqlite.close();

    const reopened = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    await expect(reopened.readAll()).rejects.toThrow("Event hash is invalid");
    await reopened.close();
  });

  it("chains consecutive events", async () => {
    const store = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    const first = await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "created",
      schemaVersion: 1,
      payload: { version: 1 }
    });
    const second = await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "updated",
      schemaVersion: 1,
      payload: { version: 2 }
    });
    expect(second.previousHash).toBe(first.eventHash);
    expect(await store.readAll()).toHaveLength(2);
    await store.close();
  });

  it("rejects snapshots that are not bound to an aggregate checkpoint", async () => {
    const store = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "created",
      schemaVersion: 1,
      payload: { version: 1 }
    });
    await expect(
      store.saveSnapshot(
        "career-twin",
        "LOCAL-001",
        1,
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        { version: 1 }
      )
    ).rejects.toThrow("does not match the aggregate event chain");
    await store.close();
  });

  it("rejects snapshot version rollback", async () => {
    const store = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    const first = await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "created",
      schemaVersion: 1,
      payload: { version: 1 }
    });
    const second = await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "updated",
      schemaVersion: 1,
      payload: { version: 2 }
    });
    await store.saveSnapshot("career-twin", "LOCAL-001", 2, second.eventHash, { version: 2 });
    await expect(store.saveSnapshot("career-twin", "LOCAL-001", 1, first.eventHash, { version: 1 })).rejects.toThrow(
      "rollback is not allowed"
    );
    await store.close();
  });

  it("detects deletion of the newest event through the authenticated chain head", async () => {
    const store = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "created",
      schemaVersion: 1,
      payload: { version: 1 }
    });
    await store.append({
      aggregateType: "career-twin",
      aggregateId: "LOCAL-001",
      eventType: "updated",
      schemaVersion: 1,
      payload: { version: 2 }
    });
    await store.close();

    const sqlite = new BetterSqlite3(databasePath);
    sqlite.prepare("DELETE FROM events WHERE sequence = 2").run();
    sqlite.close();

    const reopened = await EncryptedEventStore.open(databasePath, "correct horse battery staple");
    await expect(reopened.readAll()).rejects.toThrow("authenticated chain head");
    await reopened.close();
  });
});
