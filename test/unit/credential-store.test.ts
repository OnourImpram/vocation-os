import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ACCOUNTS,
  EncryptedFileCredentialStore,
  MemoryCredentialStore,
  loadOrCreateRuntimeSecrets
} from "../../src/security/credential-store.js";

describe("runtime credential separation", () => {
  it("generates, separates, and reuses runtime secrets", async () => {
    const credentialStore = new MemoryCredentialStore();

    const first = await loadOrCreateRuntimeSecrets(credentialStore);
    const second = await loadOrCreateRuntimeSecrets(credentialStore);
    const rollbackBackupPassphrase = await credentialStore.get(CREDENTIAL_ACCOUNTS.rollbackBackupPassphrase);

    expect(first).toEqual(second);
    expect(rollbackBackupPassphrase).not.toBeNull();
    expect(first.databasePassphrase).not.toBe(first.ipcSecret);
    expect(rollbackBackupPassphrase).not.toBe(first.databasePassphrase);
    expect(rollbackBackupPassphrase).not.toBe(first.ipcSecret);
    expect(first.artifactVaultKey).not.toBe(first.databasePassphrase);
    expect(first.artifactVaultKey).not.toBe(first.ipcSecret);
    expect(first.artifactVaultKey).not.toBe(rollbackBackupPassphrase);
    expect(first.databasePassphrase.length).toBeGreaterThanOrEqual(43);
    expect(first.ipcSecret.length).toBeGreaterThanOrEqual(43);
    expect(await credentialStore.get(CREDENTIAL_ACCOUNTS.databasePassphrase)).toBe(first.databasePassphrase);
    expect(await credentialStore.get(CREDENTIAL_ACCOUNTS.ipcSecret)).toBe(first.ipcSecret);
    expect(rollbackBackupPassphrase?.length).toBeGreaterThanOrEqual(43);
    expect(await credentialStore.get(CREDENTIAL_ACCOUNTS.artifactVaultKey)).toBe(first.artifactVaultKey);
  });

  it("persists headless credentials only inside an authenticated encrypted vault", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-headless-credentials-"));
    const filePath = path.join(dir, "credentials.vault");
    try {
      const store = await EncryptedFileCredentialStore.open(filePath, "correct horse battery staple");
      await store.set("private-test-account", "private-test-secret-value");
      await store.close();
      expect(readFileSync(filePath, "utf8")).not.toContain("private-test-secret-value");

      const reopened = await EncryptedFileCredentialStore.open(filePath, "correct horse battery staple");
      expect(await reopened.get("private-test-account")).toBe("private-test-secret-value");
      await reopened.close();
      await expect(
        EncryptedFileCredentialStore.open(filePath, "incorrect horse battery staple")
      ).rejects.toThrow("cannot be authenticated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back in-memory changes when headless vault persistence fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vocation-headless-failure-"));
    const vaultDir = path.join(root, "vault");
    const preservedDir = path.join(root, "preserved");
    const filePath = path.join(vaultDir, "credentials.vault");
    try {
      const store = await EncryptedFileCredentialStore.open(filePath, "correct horse battery staple");
      await store.set("existing-account", "existing-secret-value");
      renameSync(vaultDir, preservedDir);
      writeFileSync(vaultDir, "blocks directory recreation", "utf8");

      await expect(store.set("uncommitted-account", "uncommitted-secret-value")).rejects.toThrow();
      expect(await store.get("uncommitted-account")).toBeNull();
      await expect(store.delete("existing-account")).rejects.toThrow();
      expect(await store.get("existing-account")).toBe("existing-secret-value");
      await store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid secret already stored under a runtime credential account", async () => {
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set(CREDENTIAL_ACCOUNTS.databasePassphrase, "too-short");

    await expect(loadOrCreateRuntimeSecrets(credentialStore)).rejects.toThrow(
      "Credential account database-passphrase contains an invalid secret"
    );
    expect(await credentialStore.get(CREDENTIAL_ACCOUNTS.ipcSecret)).toBeNull();
  });
});
