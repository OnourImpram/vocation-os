#!/usr/bin/env node
import { defaultDaemonEndpoint, defaultDaemonLockPath, defaultDatabasePath, defaultRuntimeRoot } from "./paths.js";
import {
  credentialServiceName,
  EncryptedFileCredentialStore,
  loadOrCreateRuntimeSecrets,
  OsCredentialStore,
  type CredentialStore
} from "./security/credential-store.js";
import { EncryptedEventStore } from "./storage/encrypted-event-store.js";
import { RuntimeAuthority } from "./daemon/authority.js";
import { startDaemonServer } from "./daemon/server.js";
import { readMaskedSecret } from "./security/secret-input.js";
import path from "node:path";
import { acquireSingleInstanceLock } from "./runtime/single-instance.js";
import { daemonEndpointReachable } from "./ipc/client.js";
import { recoverInterruptedRestore } from "./storage/encrypted-backup.js";
import { verifyCheckpointChain } from "./security/audit-checkpoint.js";

function writeLog(level: "info" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  if (command !== "start") throw new Error(`Unknown vocationd command: ${command}`);
  const runtimeRoot = defaultRuntimeRoot();
  const endpoint = defaultDaemonEndpoint();
  const lockPath = defaultDaemonLockPath();
  const databasePath = defaultDatabasePath();
  const instanceLock = await acquireSingleInstanceLock({
    lockPath,
    endpoint,
    endpointReachable: daemonEndpointReachable
  });
  let credentialStore: CredentialStore | null = null;
  let store: EncryptedEventStore | null = null;
  let server: Awaited<ReturnType<typeof startDaemonServer>> | null = null;
  try {
    if (process.argv.includes("--headless")) {
      const passphrase = await readMaskedSecret("Headless master passphrase: ");
      credentialStore = await EncryptedFileCredentialStore.open(
        path.join(runtimeRoot, "headless-credentials.vault"),
        passphrase
      );
    } else {
      credentialStore = await OsCredentialStore.create(credentialServiceName(runtimeRoot));
    }
    const secrets = await loadOrCreateRuntimeSecrets(credentialStore);
    await recoverInterruptedRestore({
      journalPath: `${databasePath}.restore-journal.json`,
      databasePath,
      storePassphrase: secrets.databasePassphrase
    });
    store = await EncryptedEventStore.open(databasePath, secrets.databasePassphrase);
    await verifyCheckpointChain(store, credentialStore);
    const authority = new RuntimeAuthority(store, credentialStore, runtimeRoot);
    server = await startDaemonServer({
      endpoint,
      lockPath,
      ipcSecret: secrets.ipcSecret,
      authority,
      instanceLock
    });
  } catch (error) {
    await store?.close();
    await credentialStore?.close?.();
    instanceLock.release();
    throw error;
  }
  if (!credentialStore || !store || !server) throw new Error("Daemon initialization did not complete");
  writeLog("info", "vocationd.started", {
    endpoint: server.endpoint,
    databaseId: await store.databaseId(),
    productionExecutionAdapters: 0
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    writeLog("info", "vocationd.stopping", { signal });
    try {
      await server.close();
      await store.close();
      await credentialStore.close?.();
      writeLog("info", "vocationd.stopped");
      process.exitCode = 0;
    } catch (error) {
      writeLog("error", "vocationd.stop_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

try {
  await main();
} catch (error) {
  writeLog("error", "vocationd.start_failed", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
}
