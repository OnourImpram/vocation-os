import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { sha256 } from "../hash.js";

export interface CredentialStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
  close?(): Promise<void>;
}

interface NativeEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface NativeKeyringModule {
  Entry: new (service: string, account: string) => NativeEntry;
}

export const CREDENTIAL_ACCOUNTS = {
  databasePassphrase: "database-passphrase",
  ipcSecret: "ipc-secret",
  checkpointPrivateKey: "checkpoint-private-key",
  latestCheckpointDigest: "latest-checkpoint-digest",
  deviceId: "device-id",
  rollbackBackupPassphrase: "rollback-backup-passphrase",
  artifactVaultKey: "artifact-vault-key"
} as const;

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  public async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  public async set(account: string, secret: string): Promise<void> {
    if (secret.length === 0) throw new Error("Credential secret cannot be empty");
    this.values.set(account, secret);
  }

  public async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

export class OsCredentialStore implements CredentialStore {
  private constructor(
    private readonly service: string,
    private readonly keyring: NativeKeyringModule
  ) {}

  public static async create(service: string): Promise<OsCredentialStore> {
    if (!/^[A-Za-z0-9._:-]{3,128}$/.test(service)) {
      throw new Error("Credential service name is invalid");
    }
    try {
      const moduleName = "@napi-rs/keyring";
      const keyring = await import(moduleName) as NativeKeyringModule;
      if (typeof keyring.Entry !== "function") throw new Error("Entry API is unavailable");
      return new OsCredentialStore(service, keyring);
    } catch {
      throw new Error("Native OS credential store is unavailable. VocationOS will not use a file or shell fallback");
    }
  }

  public async get(account: string): Promise<string | null> {
    try {
      return new this.keyring.Entry(this.service, account).getPassword();
    } catch {
      throw new Error(`Unable to read credential account ${account} from the native OS store`);
    }
  }

  public async set(account: string, secret: string): Promise<void> {
    if (secret.length === 0) throw new Error("Credential secret cannot be empty");
    try {
      new this.keyring.Entry(this.service, account).setPassword(secret);
    } catch {
      throw new Error(`Unable to write credential account ${account} to the native OS store`);
    }
  }

  public async delete(account: string): Promise<boolean> {
    try {
      return new this.keyring.Entry(this.service, account).deletePassword();
    } catch {
      throw new Error(`Unable to delete credential account ${account} from the native OS store`);
    }
  }
}

interface EncryptedCredentialEnvelope {
  format: "vocation-os-headless-credentials";
  version: 1;
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

const HEADLESS_CREDENTIAL_AAD = "vocation-os:headless-credentials:v1";

function deriveHeadlessKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 16) throw new Error("Headless master passphrase must contain at least 16 characters");
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export class EncryptedFileCredentialStore implements CredentialStore {
  private constructor(
    private readonly filePath: string,
    private readonly salt: Buffer,
    private readonly key: Buffer,
    private readonly values: Map<string, string>
  ) {}

  public static async open(filePath: string, passphrase: string): Promise<EncryptedFileCredentialStore> {
    const resolvedPath = path.resolve(filePath);
    if (!existsSync(resolvedPath)) {
      const salt = randomBytes(16);
      const store = new EncryptedFileCredentialStore(
        resolvedPath,
        salt,
        deriveHeadlessKey(passphrase, salt),
        new Map()
      );
      store.persist();
      return store;
    }
    let envelope: EncryptedCredentialEnvelope;
    try {
      envelope = JSON.parse(readFileSync(resolvedPath, "utf8")) as EncryptedCredentialEnvelope;
    } catch {
      throw new Error("Headless credential vault is not valid JSON");
    }
    if (envelope.format !== "vocation-os-headless-credentials" || envelope.version !== 1) {
      throw new Error("Unsupported headless credential vault format");
    }
    const salt = Buffer.from(envelope.salt, "base64url");
    const key = deriveHeadlessKey(passphrase, salt);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
      decipher.setAAD(Buffer.from(HEADLESS_CREDENTIAL_AAD, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final()
      ]).toString("utf8");
      const parsed = JSON.parse(plaintext) as Record<string, unknown>;
      const values = new Map<string, string>();
      for (const [account, secret] of Object.entries(parsed)) {
        if (typeof secret !== "string" || secret.length === 0) throw new Error("invalid credential entry");
        values.set(account, secret);
      }
      return new EncryptedFileCredentialStore(resolvedPath, salt, key, values);
    } catch {
      key.fill(0);
      throw new Error("Headless credential vault cannot be authenticated with the supplied passphrase");
    }
  }

  private persist(): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(HEADLESS_CREDENTIAL_AAD, "utf8"));
    const plaintext = JSON.stringify(Object.fromEntries([...this.values.entries()].sort(([left], [right]) => left.localeCompare(right))));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope: EncryptedCredentialEnvelope = {
      format: "vocation-os-headless-credentials",
      version: 1,
      salt: this.salt.toString("base64url"),
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    };
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const descriptor = openSync(temporaryPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(envelope)}\n`, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  public async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  public async set(account: string, secret: string): Promise<void> {
    if (secret.length === 0) throw new Error("Credential secret cannot be empty");
    const previous = this.values.get(account);
    this.values.set(account, secret);
    try {
      this.persist();
    } catch (error) {
      if (previous === undefined) this.values.delete(account);
      else this.values.set(account, previous);
      throw error;
    }
  }

  public async delete(account: string): Promise<boolean> {
    const previous = this.values.get(account);
    const deleted = this.values.delete(account);
    if (deleted) {
      try {
        this.persist();
      } catch (error) {
        this.values.set(account, previous!);
        throw error;
      }
    }
    return deleted;
  }

  public async close(): Promise<void> {
    this.key.fill(0);
    this.values.clear();
  }
}

export function credentialServiceName(runtimeRoot: string): string {
  const namespace = sha256(path.resolve(runtimeRoot)).slice("sha256:".length, "sha256:".length + 24);
  return `vocation-os:${namespace}`;
}

export async function getOrCreateCredential(
  store: CredentialStore,
  account: string,
  bytes = 32
): Promise<string> {
  const existing = await store.get(account);
  if (existing !== null) {
    if (existing.length < 16) throw new Error(`Credential account ${account} contains an invalid secret`);
    return existing;
  }
  const created = randomBytes(bytes).toString("base64url");
  await store.set(account, created);
  const verified = await store.get(account);
  if (verified !== created) throw new Error(`Credential account ${account} failed read after write verification`);
  return created;
}

async function getOrCreateIpcSecret(store: CredentialStore): Promise<string> {
  const existing = await store.get(CREDENTIAL_ACCOUNTS.ipcSecret);
  if (existing !== null) {
    if (existing.length < 16) throw new Error("Credential account ipc-secret contains an invalid secret");
    return existing;
  }
  const created = randomBytes(32).toString("base64url");
  await store.set(CREDENTIAL_ACCOUNTS.ipcSecret, created);
  const verified = await store.get(CREDENTIAL_ACCOUNTS.ipcSecret);
  if (verified !== created) throw new Error("Credential account ipc-secret failed read after write verification");
  return created;
}

export interface RuntimeSecrets {
  databasePassphrase: string;
  ipcSecret: string;
  artifactVaultKey: string;
}

export async function loadOrCreateRuntimeSecrets(store: CredentialStore): Promise<RuntimeSecrets> {
  const databasePassphrase = await getOrCreateCredential(store, CREDENTIAL_ACCOUNTS.databasePassphrase, 32);
  const ipcSecret = await getOrCreateIpcSecret(store);
  const rollbackBackupPassphrase = await getOrCreateCredential(
    store,
    CREDENTIAL_ACCOUNTS.rollbackBackupPassphrase,
    32
  );
  const artifactVaultKey = await getOrCreateCredential(store, CREDENTIAL_ACCOUNTS.artifactVaultKey, 32);
  if (new Set([databasePassphrase, ipcSecret, rollbackBackupPassphrase, artifactVaultKey]).size !== 4) {
    throw new Error("Runtime credential separation invariant failed");
  }
  return { databasePassphrase, ipcSecret, artifactVaultKey };
}
