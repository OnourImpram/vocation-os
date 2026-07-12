import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import { startDaemonServer, type DaemonServerHandle } from "../../src/daemon/server.js";
import { callAuthority } from "../../src/ipc/client.js";
import { CREDENTIAL_ACCOUNTS, MemoryCredentialStore } from "../../src/security/credential-store.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";

const STORE_PASSPHRASE = "correct horse battery staple";
const IPC_SECRET = "test-ipc-secret-with-enough-entropy";

function testEndpoint(runtimeRoot: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\vocation-os-test-${randomUUID()}`;
  }
  return path.join(runtimeRoot, "vocationd.sock");
}

describe("daemon authority boundary", () => {
  let runtimeRoot: string;
  let databasePath: string;
  let lockPath: string;
  let endpoint: string;
  let store: EncryptedEventStore;
  let credentials: MemoryCredentialStore;
  let authority: RuntimeAuthority;
  let server: DaemonServerHandle | null;

  beforeEach(async () => {
    runtimeRoot = mkdtempSync(path.join(tmpdir(), "vocation-daemon-authority-"));
    databasePath = path.join(runtimeRoot, "vocation.db");
    lockPath = path.join(runtimeRoot, "vocationd.lock.json");
    endpoint = testEndpoint(runtimeRoot);
    credentials = new MemoryCredentialStore();
    await credentials.set(CREDENTIAL_ACCOUNTS.databasePassphrase, STORE_PASSPHRASE);
    await credentials.set(CREDENTIAL_ACCOUNTS.ipcSecret, IPC_SECRET);
    store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    authority = new RuntimeAuthority(store, credentials, runtimeRoot);
    server = null;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    await store.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  async function startServer(): Promise<void> {
    server = await startDaemonServer({
      endpoint,
      lockPath,
      ipcSecret: IPC_SECRET,
      authority
    });
  }

  it("serves authenticated requests and rejects a wrong IPC secret", async () => {
    await startServer();

    await expect(callAuthority({
      endpoint,
      ipcSecret: IPC_SECRET,
      operation: "health",
      requestId: "REQ-HEALTH-0001"
    })).resolves.toMatchObject({
      status: "ok",
      eventCount: 0
    });

    await expect(callAuthority({
      endpoint,
      ipcSecret: "wrong-secret-with-enough-length",
      operation: "health",
      requestId: "REQ-HEALTH-0002",
      timeoutMs: 1000
    })).rejects.toThrow(/closed|timed out|invalid|authentication/i);
  });

  it("signals shutdown only after an authenticated authority command is persisted", async () => {
    await startServer();
    if (!server) throw new Error("Daemon server fixture did not start");
    const shutdownSignal = server.shutdownRequested;

    await expect(callAuthority({
      endpoint,
      ipcSecret: IPC_SECRET,
      operation: "daemon-stop",
      payload: {},
      requestId: "REQ-DAEMON-STOP-0001"
    })).resolves.toMatchObject({ status: "shutdown-authorized" });
    await expect(shutdownSignal).resolves.toBeUndefined();
    expect((await store.readAll()).map((event) => event.eventType)).toEqual(["daemon-stop-completed"]);
  });

  it("replays identical mutating requests and rejects request id reuse with different payloads", async () => {
    await startServer();

    const first = await callAuthority({
      endpoint,
      ipcSecret: IPC_SECRET,
      operation: "auto-apply-kill",
      payload: { reason: "operator halt" },
      requestId: "REQ-IDEMPOTENT-0001"
    });
    const replay = await callAuthority({
      endpoint,
      ipcSecret: IPC_SECRET,
      operation: "auto-apply-kill",
      payload: { reason: "operator halt" },
      requestId: "REQ-IDEMPOTENT-0001"
    });

    expect(replay).toStrictEqual(first);
    expect((await store.readAll()).map((event) => event.eventType)).toEqual([
      "auto-apply-kill-completed"
    ]);

    await expect(callAuthority({
      endpoint,
      ipcSecret: IPC_SECRET,
      operation: "auto-apply-kill",
      payload: { reason: "different reason" },
      requestId: "REQ-IDEMPOTENT-0001"
    })).rejects.toThrow("request id was reused with different parameters");
    expect(await store.readAll()).toHaveLength(1);
  });

  it("creates verifiable signed checkpoints through the authority boundary", async () => {
    await startServer();

    const checkpoint = await callAuthority({
      endpoint,
      ipcSecret: IPC_SECRET,
      operation: "checkpoint-create",
      requestId: "REQ-CHECKPOINT-0001"
    });
    const replay = await callAuthority({
      endpoint,
      ipcSecret: IPC_SECRET,
      operation: "checkpoint-create",
      requestId: "REQ-CHECKPOINT-0001"
    });

    expect(replay).toStrictEqual(checkpoint);
    expect(await callAuthority({
      endpoint,
      ipcSecret: IPC_SECRET,
      operation: "checkpoint-verify",
      requestId: "REQ-CHECKPOINT-VERIFY"
    })).toMatchObject({
      valid: true,
      checkpointCount: 1,
      externalDigestMatched: true
    });
  });

  it("refuses a second daemon on the same runtime lock", async () => {
    await startServer();

    await expect(startDaemonServer({
      endpoint,
      lockPath,
      ipcSecret: IPC_SECRET,
      authority
    })).rejects.toThrow("already running");
  });
});
