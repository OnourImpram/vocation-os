import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import { CREDENTIAL_ACCOUNTS, MemoryCredentialStore } from "../../src/security/credential-store.js";
import { inspectEncryptedBackup } from "../../src/storage/encrypted-backup.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";

const STORE_PASSPHRASE = "runtime authority test passphrase";

describe("runtime authority", () => {
  let dir: string;
  let databasePath: string;
  let store: EncryptedEventStore | undefined;
  let credentials: MemoryCredentialStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vocation-authority-"));
    databasePath = path.join(dir, "vocation.db");
    credentials = new MemoryCredentialStore();
  });

  afterEach(async () => {
    if (store) {
      await store.close();
      store = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function openAuthority(): Promise<RuntimeAuthority> {
    store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    return new RuntimeAuthority(store, credentials, dir);
  }

  it("persists an engaged kill switch across store reopen", async () => {
    const authority = await openAuthority();
    const killed = await authority.execute(
      {
        id: "REQ-KILL-PERSIST-0001",
        operation: "auto-apply-kill",
        payload: { reason: "operator safety stop" }
      },
      new Date("2026-07-11T10:00:00.000Z")
    );

    expect(killed).toMatchObject({
      enabled: false,
      mode: "manual",
      killSwitch: {
        available: true,
        engaged: true,
        engagedAt: "2026-07-11T10:00:00.000Z",
        engagedBy: "authenticated-local-operator",
        reason: "operator safety stop"
      }
    });

    await store?.close();
    store = undefined;

    const reopenedAuthority = await openAuthority();
    const status = await reopenedAuthority.execute({
      id: "REQ-KILL-STATUS-0001",
      operation: "auto-apply-status",
      payload: {}
    });

    expect(status).toMatchObject({
      config: {
        enabled: false,
        mode: "manual",
        killSwitch: {
          engaged: true,
          reason: "operator safety stop"
        }
      }
    });
  });

  it("keeps rearm disabled and manual until a separate enable command", async () => {
    const authority = await openAuthority();
    await authority.execute({
      id: "REQ-KILL-SEQUENCE-0001",
      operation: "auto-apply-kill",
      payload: { reason: "verify explicit transitions" }
    });

    const rearmed = await authority.execute({
      id: "REQ-REARM-SEQUENCE-0001",
      operation: "auto-apply-rearm",
      payload: {}
    });
    expect(rearmed).toMatchObject({
      enabled: false,
      mode: "manual",
      killSwitch: { available: true, engaged: false }
    });

    const enabled = await authority.execute({
      id: "REQ-ENABLE-SEQUENCE-0001",
      operation: "auto-apply-enable",
      payload: { mode: "auto" }
    });
    expect(enabled).toMatchObject({
      enabled: true,
      mode: "auto",
      killSwitch: { engaged: false }
    });

    expect(await store?.readAggregate("runtime-config", "auto-apply")).toHaveLength(3);
  });

  it("replays an identical request without appending a second event", async () => {
    const authority = await openAuthority();
    const request = {
      id: "REQ-IDEMPOTENT-KILL-0001",
      operation: "auto-apply-kill" as const,
      payload: { reason: "idempotency check" }
    };

    const first = await authority.execute(request, new Date("2026-07-11T10:00:00.000Z"));
    const replay = await authority.execute(request, new Date("2026-07-11T11:00:00.000Z"));

    expect(replay).toEqual(first);
    expect((await store?.chainHead())?.eventCount).toBe(1);
    expect(await store?.readAggregate("runtime-config", "auto-apply")).toHaveLength(1);
  });

  it("rejects reuse of a request id with a different payload", async () => {
    const authority = await openAuthority();
    await authority.execute({
      id: "REQ-COLLISION-KILL-0001",
      operation: "auto-apply-kill",
      payload: { reason: "first payload" }
    });

    await expect(authority.execute({
      id: "REQ-COLLISION-KILL-0001",
      operation: "auto-apply-kill",
      payload: { reason: "different payload" }
    })).rejects.toThrow("reused with different parameters");

    expect((await store?.chainHead())?.eventCount).toBe(1);
  });

  it("binds every import rollback backup to the current pre-import chain head", async () => {
    const authority = await openAuthority();
    const plan = await authority.execute({
      id: "REQ-IMPORT-PLAN-0001",
      operation: "legacy-import-plan",
      payload: {}
    }) as { planHash: string };
    const first = await authority.execute({
      id: "REQ-IMPORT-APPLY-0001",
      operation: "legacy-import-apply",
      payload: { planHash: plan.planHash }
    }) as { rollbackBackupPath: string };
    await authority.execute({
      id: "REQ-IMPORT-INTERVENING-0001",
      operation: "auto-apply-kill",
      payload: { reason: "intervening event" }
    });
    const second = await authority.execute({
      id: "REQ-IMPORT-APPLY-0002",
      operation: "legacy-import-apply",
      payload: { planHash: plan.planHash }
    }) as { rollbackBackupPath: string };

    expect(second.rollbackBackupPath).not.toBe(first.rollbackBackupPath);
    const rollbackPassphrase = await credentials.get(CREDENTIAL_ACCOUNTS.rollbackBackupPassphrase);
    expect(rollbackPassphrase).not.toBeNull();
    expect(inspectEncryptedBackup(first.rollbackBackupPath, rollbackPassphrase!)).toMatchObject({ eventCount: 0 });
    expect(inspectEncryptedBackup(second.rollbackBackupPath, rollbackPassphrase!)).toMatchObject({ eventCount: 2 });
  });
});
