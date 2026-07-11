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
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { sha256, stableStringify } from "../hash.js";
import { assertSchema } from "../schema.js";
import { EncryptedEventStore } from "./encrypted-event-store.js";
import {
  readOperationJournal,
  writeOperationJournal,
  type StorageOperationJournal
} from "./operation-journal.js";

const BACKUP_AAD = "vocation-os:encrypted-backup:v1";

interface BackupEnvelope {
  format: "vocation-os-encrypted-backup";
  version: 1;
  kdf: "scrypt-n32768-r8-p1";
  cipher: "aes-256-gcm";
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface BackupManifest {
  format: "vocation-os-sqlite";
  version: 1;
  createdAt: string;
  databaseId: string;
  databaseHash: string;
  eventCount: number;
  eventChainHead: string;
  migrationVersions: number[];
}

interface BackupPayload {
  manifest: BackupManifest;
  database: string;
}

export interface RestoreResult {
  databasePath: string;
  databaseId: string;
  eventCount: number;
  rollbackPath: string | null;
  journalPath: string;
}

export function createEncryptedBackupFromImage(input: {
  database: Buffer;
  backupPath: string;
  backupPassphrase: string;
  databaseId: string;
  eventCount: number;
  eventChainHead: string;
  migrationVersions: number[];
  createdAt?: Date;
  overwrite?: boolean;
}): BackupManifest {
  const manifest: BackupManifest = {
    format: "vocation-os-sqlite",
    version: 1,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    databaseId: input.databaseId,
    databaseHash: sha256(input.database),
    eventCount: input.eventCount,
    eventChainHead: input.eventChainHead,
    migrationVersions: input.migrationVersions
  };
  assertSchema("backup-manifest", manifest);
  const envelope = encryptPayload({ manifest, database: input.database.toString("base64") }, input.backupPassphrase);
  atomicWrite(path.resolve(input.backupPath), `${JSON.stringify(envelope)}\n`, input.overwrite === true);
  return manifest;
}

function deriveBackupKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 12) throw new Error("Backup passphrase must contain at least 12 characters");
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function atomicWrite(filePath: string, data: string | Buffer, overwrite: boolean): void {
  if (!overwrite && existsSync(filePath)) throw new Error(`Refusing to overwrite existing file: ${filePath}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, data);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function encryptPayload(payload: BackupPayload, passphrase: string): BackupEnvelope {
  const salt = randomBytes(16);
  const key = deriveBackupKey(passphrase, salt);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(BACKUP_AAD, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(stableStringify(payload), "utf8"),
      cipher.final()
    ]);
    return {
      format: "vocation-os-encrypted-backup",
      version: 1,
      kdf: "scrypt-n32768-r8-p1",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64url"),
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    };
  } finally {
    key.fill(0);
  }
}

function decryptEnvelope(envelope: BackupEnvelope, passphrase: string): BackupPayload {
  if (
    envelope.format !== "vocation-os-encrypted-backup"
    || envelope.version !== 1
    || envelope.kdf !== "scrypt-n32768-r8-p1"
    || envelope.cipher !== "aes-256-gcm"
  ) {
    throw new Error("Unsupported VocationOS backup envelope");
  }
  const key = deriveBackupKey(passphrase, Buffer.from(envelope.salt, "base64url"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
    decipher.setAAD(Buffer.from(BACKUP_AAD, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext) as BackupPayload;
  } catch {
    throw new Error("Encrypted backup cannot be authenticated with the supplied passphrase");
  } finally {
    key.fill(0);
  }
}

function readBackupPayload(filePath: string, passphrase: string): BackupPayload {
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(readFileSync(filePath, "utf8")) as BackupEnvelope;
  } catch {
    throw new Error("Backup file is not valid JSON");
  }
  const payload = decryptEnvelope(envelope, passphrase);
  assertSchema("backup-manifest", payload.manifest);
  const database = Buffer.from(payload.database, "base64");
  if (payload.manifest.databaseHash !== sha256(database)) {
    throw new Error("Backup database hash does not match the authenticated manifest");
  }
  return payload;
}

export async function createEncryptedBackup(
  store: EncryptedEventStore,
  backupPath: string,
  backupPassphrase: string,
  options: { overwrite?: boolean; now?: Date } = {}
): Promise<BackupManifest> {
  const database = store.serializeDatabase();
  try {
    const head = await store.chainHead();
    return createEncryptedBackupFromImage({
      database,
      backupPath,
      backupPassphrase,
      databaseId: await store.databaseId(),
      eventCount: head.eventCount,
      eventChainHead: head.headHash,
      migrationVersions: store.migrations().map((migration) => migration.version),
      ...(options.now ? { createdAt: options.now } : {}),
      ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {})
    });
  } finally {
    database.fill(0);
  }
}

export function inspectEncryptedBackup(backupPath: string, backupPassphrase: string): BackupManifest {
  const manifest = readBackupPayload(path.resolve(backupPath), backupPassphrase).manifest;
  assertSchema("backup-manifest", manifest);
  return manifest;
}

function moveIfPresent(source: string, destination: string): boolean {
  if (!existsSync(source)) return false;
  renameSync(source, destination);
  return true;
}

function removeDatabaseImage(filePath: string): void {
  rmSync(filePath, { force: true });
  rmSync(`${filePath}-wal`, { force: true });
  rmSync(`${filePath}-shm`, { force: true });
}

async function verifyDatabaseImage(filePath: string, storePassphrase: string): Promise<void> {
  const store = await EncryptedEventStore.open(filePath, storePassphrase);
  try {
    await store.verifyIntegrity();
  } finally {
    await store.close();
  }
}

export async function recoverInterruptedRestore(input: {
  journalPath: string;
  databasePath: string;
  storePassphrase: string;
  now?: Date;
}): Promise<{ recovered: boolean; outcome: "none" | "complete" | "rolled_back" }> {
  const journalPath = path.resolve(input.journalPath);
  const databasePath = path.resolve(input.databasePath);
  const journal = readOperationJournal(journalPath);
  if (!journal) return { recovered: false, outcome: "none" };
  if (journal.operation !== "restore" || path.resolve(journal.targetPath) !== databasePath) {
    throw new Error("Restore journal does not belong to the canonical database target");
  }
  if (journal.phase === "complete") return { recovered: false, outcome: "complete" };
  if (journal.phase === "rolled_back") return { recovered: false, outcome: "rolled_back" };
  const stagingPath = journal.stagingPath ? path.resolve(journal.stagingPath) : null;
  const rollbackPath = journal.rollbackPath ? path.resolve(journal.rollbackPath) : null;
  const databaseDirectory = path.dirname(databasePath);
  for (const candidate of [stagingPath, rollbackPath]) {
    if (!candidate) continue;
    const relative = path.relative(databaseDirectory, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Restore journal references a path outside the canonical database directory");
    }
  }
  const completeJournal = (phase: "complete" | "rolled_back"): void => {
    journal.phase = phase;
    journal.updatedAt = (input.now ?? new Date()).toISOString();
    writeOperationJournal(journalPath, journal);
  };

  if (existsSync(databasePath)) {
    if (journal.phase === "prepared" || journal.phase === "staged" || journal.phase === "verified") {
      if (stagingPath) removeDatabaseImage(stagingPath);
      completeJournal("rolled_back");
      return { recovered: true, outcome: "rolled_back" };
    }
    await verifyDatabaseImage(databasePath, input.storePassphrase);
    if (stagingPath) removeDatabaseImage(stagingPath);
    completeJournal("complete");
    return { recovered: true, outcome: "complete" };
  }

  if (rollbackPath && existsSync(rollbackPath)) {
    renameSync(rollbackPath, databasePath);
    moveIfPresent(`${rollbackPath}-wal`, `${databasePath}-wal`);
    moveIfPresent(`${rollbackPath}-shm`, `${databasePath}-shm`);
    if (stagingPath) removeDatabaseImage(stagingPath);
    await verifyDatabaseImage(databasePath, input.storePassphrase);
    completeJournal("rolled_back");
    return { recovered: true, outcome: "rolled_back" };
  }

  if (stagingPath && existsSync(stagingPath) && journal.phase === "verified") {
    await verifyDatabaseImage(stagingPath, input.storePassphrase);
    renameSync(stagingPath, databasePath);
    completeJournal("complete");
    return { recovered: true, outcome: "complete" };
  }

  if (
    journal.phase === "prepared"
    && (!stagingPath || !existsSync(stagingPath))
    && (!rollbackPath || !existsSync(rollbackPath))
  ) {
    completeJournal("rolled_back");
    return { recovered: true, outcome: "rolled_back" };
  }
  throw new Error("Interrupted restore state is ambiguous. Refusing to initialize a replacement store");
}

export async function restoreEncryptedBackup(input: {
  backupPath: string;
  backupPassphrase: string;
  databasePath: string;
  storePassphrase: string;
  replaceExisting?: boolean;
  journalPath?: string;
  now?: Date;
  validateStaged?: (store: EncryptedEventStore) => Promise<void>;
  afterSwapValidated?: (store: EncryptedEventStore) => Promise<void>;
}): Promise<RestoreResult> {
  const now = input.now ?? new Date();
  const databasePath = path.resolve(input.databasePath);
  const backupPath = path.resolve(input.backupPath);
  const journalPath = path.resolve(input.journalPath ?? `${databasePath}.restore-journal.json`);
  if (!existsSync(backupPath)) throw new Error("Backup file does not exist");
  if (existsSync(databasePath) && input.replaceExisting !== true) {
    throw new Error("Restore target exists. Explicit replacement approval is required");
  }
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const operationId = `RESTORE-${randomUUID()}`;
  const stagingPath = `${databasePath}.${operationId}.staging`;
  const rollbackPath = existsSync(databasePath) ? `${databasePath}.${operationId}.rollback` : null;
  const payload = readBackupPayload(backupPath, input.backupPassphrase);
  const journal: StorageOperationJournal = {
    version: 1,
    operationId,
    operation: "restore",
    phase: "prepared",
    targetPath: databasePath,
    stagingPath,
    ...(rollbackPath ? { rollbackPath } : {}),
    expectedHash: payload.manifest.databaseHash,
    updatedAt: now.toISOString()
  };
  writeOperationJournal(journalPath, journal);

  try {
    atomicWrite(stagingPath, Buffer.from(payload.database, "base64"), false);
    journal.phase = "staged";
    journal.updatedAt = new Date(now.getTime() + 1).toISOString();
    writeOperationJournal(journalPath, journal);

    const staged = await EncryptedEventStore.open(stagingPath, input.storePassphrase);
    try {
      const verification = await staged.verifyIntegrity();
      const restoredMigrationVersions = staged.migrations().map((migration) => migration.version);
      const manifestMigrationPrefix = restoredMigrationVersions.slice(0, payload.manifest.migrationVersions.length);
      if (
        (await staged.databaseId()) !== payload.manifest.databaseId
        || verification.eventCount !== payload.manifest.eventCount
        || verification.head.headHash !== payload.manifest.eventChainHead
        || stableStringify(manifestMigrationPrefix) !== stableStringify(payload.manifest.migrationVersions)
      ) {
        throw new Error("Staged restore does not match the authenticated backup manifest");
      }
      await input.validateStaged?.(staged);
    } finally {
      await staged.close();
    }
  } catch (error) {
    removeDatabaseImage(stagingPath);
    journal.phase = "rolled_back";
    journal.updatedAt = new Date(now.getTime() + 2).toISOString();
    writeOperationJournal(journalPath, journal);
    throw error;
  }
  journal.phase = "verified";
  journal.updatedAt = new Date(now.getTime() + 2).toISOString();
  writeOperationJournal(journalPath, journal);

  let movedDatabase = false;
  let movedWal = false;
  let movedShm = false;
  try {
    if (rollbackPath) {
      movedDatabase = moveIfPresent(databasePath, rollbackPath);
      movedWal = moveIfPresent(`${databasePath}-wal`, `${rollbackPath}-wal`);
      movedShm = moveIfPresent(`${databasePath}-shm`, `${rollbackPath}-shm`);
      journal.phase = "backup_complete";
      journal.updatedAt = new Date(now.getTime() + 3).toISOString();
      writeOperationJournal(journalPath, journal);
    }
    renameSync(stagingPath, databasePath);
    journal.phase = "swapped";
    journal.updatedAt = new Date(now.getTime() + 4).toISOString();
    writeOperationJournal(journalPath, journal);

    const restored = await EncryptedEventStore.open(databasePath, input.storePassphrase);
    try {
      await restored.verifyIntegrity();
      await input.afterSwapValidated?.(restored);
    } finally {
      await restored.close();
    }
    journal.phase = "complete";
    journal.updatedAt = new Date(now.getTime() + 5).toISOString();
    writeOperationJournal(journalPath, journal);
    return {
      databasePath,
      databaseId: payload.manifest.databaseId,
      eventCount: payload.manifest.eventCount,
      rollbackPath,
      journalPath
    };
  } catch (error) {
    removeDatabaseImage(databasePath);
    if (rollbackPath && movedDatabase) renameSync(rollbackPath, databasePath);
    if (rollbackPath && movedWal) renameSync(`${rollbackPath}-wal`, `${databasePath}-wal`);
    if (rollbackPath && movedShm) renameSync(`${rollbackPath}-shm`, `${databasePath}-shm`);
    removeDatabaseImage(stagingPath);
    journal.phase = "rolled_back";
    journal.updatedAt = new Date(now.getTime() + 6).toISOString();
    writeOperationJournal(journalPath, journal);
    throw error;
  }
}
