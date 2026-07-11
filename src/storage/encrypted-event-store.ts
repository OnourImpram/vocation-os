import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { Generated, Kysely, SqliteDialect } from "kysely";
import { sha256, stableStringify } from "../hash.js";
import {
  applyStoreMigrations,
  LATEST_STORE_MIGRATION,
  listStoreMigrations,
  type AppliedMigration
} from "./migrations.js";

interface EventRow {
  sequence: Generated<number>;
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  payload_ciphertext: string;
  payload_nonce: string;
  payload_tag: string;
  previous_hash: string;
  event_hash: string;
}

interface SnapshotRow {
  aggregate_type: string;
  aggregate_id: string;
  version: number;
  created_at: string;
  last_event_hash: string;
  payload_ciphertext: string;
  payload_nonce: string;
  payload_tag: string;
}

interface MetadataRow {
  key: string;
  value: string;
}

interface StoreDatabase {
  events: EventRow;
  snapshots: SnapshotRow;
  metadata: MetadataRow;
}

interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
  tag: string;
}

export interface ChainHead {
  eventCount: number;
  headHash: string;
}

export interface LegacyImportReceipt {
  sourceDigest: string;
  sourceKind: string;
  sourceLocatorHash: string;
  eventId: string;
  importedAt: string;
}

export interface AuthorityReceipt {
  requestId: string;
  requestHash: string;
  operation: string;
  eventId: string | null;
  responseHash: string;
  completedAt: string;
}

export interface SignedCheckpointRecord {
  checkpointId: string;
  databaseId: string;
  schemaVersion: number;
  eventCount: number;
  headHash: string;
  createdAt: string;
  deviceId: string;
  keyId: string;
  previousCheckpointDigest: string;
  publicKeyPem: string;
  signature: string;
}

export interface AppendEventInput<T> {
  eventId?: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  schemaVersion: number;
  payload: T;
  occurredAt?: Date;
}

export interface StoredEvent<T> {
  sequence: number;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  previousHash: string;
  eventHash: string;
  payload: T;
}

export interface StoredSnapshot<T> {
  aggregateType: string;
  aggregateId: string;
  version: number;
  createdAt: string;
  lastEventHash: string;
  payload: T;
}

const GENESIS_HASH = sha256("vocation-os:event-chain:v1");
const KEY_CHECK_AAD = "vocation-os:key-check:v1";
const KEY_CHECK_VALUE = "vocation-os-encrypted-store";
const CHAIN_HEAD_AAD = "vocation-os:chain-head:v1";

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be an opaque identifier without whitespace`);
  }
}

function assertSchemaVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Event schema version must be a positive integer");
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 12) {
    throw new Error("Local store passphrase must contain at least 12 characters");
  }
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(key: Buffer, plaintext: string, aad: string): EncryptedPayload {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}

function decrypt(key: Buffer, payload: EncryptedPayload, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.nonce, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function eventAad(input: {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
}): string {
  return stableStringify(input);
}

function snapshotAad(input: {
  aggregateType: string;
  aggregateId: string;
  version: number;
  lastEventHash: string;
}): string {
  return stableStringify(input);
}

function computeEventHash(row: Omit<EventRow, "sequence" | "event_hash">): string {
  return sha256(stableStringify(row));
}

function encodeChainHead(key: Buffer, head: ChainHead): string {
  return JSON.stringify(encrypt(key, stableStringify(head), CHAIN_HEAD_AAD));
}

function decodeChainHead(key: Buffer, value: string): ChainHead {
  try {
    const encrypted = JSON.parse(value) as EncryptedPayload;
    const parsed = JSON.parse(decrypt(key, encrypted, CHAIN_HEAD_AAD)) as Partial<ChainHead>;
    if (!Number.isInteger(parsed.eventCount) || (parsed.eventCount ?? -1) < 0) throw new Error("invalid event count");
    if (typeof parsed.headHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(parsed.headHash)) throw new Error("invalid head hash");
    return { eventCount: parsed.eventCount!, headHash: parsed.headHash };
  } catch {
    throw new Error("Encrypted event chain head cannot be authenticated");
  }
}

function readExistingMetadata(sqlite: BetterSqlite3.Database): Map<string, string> {
  try {
    const rows = sqlite.prepare(`
      SELECT key, value FROM metadata
      WHERE key IN (
        'encryption_salt',
        'key_check_ciphertext',
        'key_check_nonce',
        'key_check_tag',
        'event_chain_head',
        'database_id'
      )
    `).all() as MetadataRow[];
    return new Map(rows.map((row) => [row.key, row.value]));
  } catch {
    throw new Error("Existing database is not a recognizable encrypted VocationOS store");
  }
}

function databaseIdFromSalt(salt: string): string {
  const hex = sha256(`vocation-os:database-id:${salt}`).slice("sha256:".length, "sha256:".length + 32);
  return `DB-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function authenticateExistingStore(sqlite: BetterSqlite3.Database, passphrase: string): Buffer {
  const integrity = sqlite.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`SQLite integrity check failed before migration: ${String(integrity)}`);
  }
  const metadata = readExistingMetadata(sqlite);
  const salt = metadata.get("encryption_salt");
  const chainHeadValue = metadata.get("event_chain_head");
  if (!salt || !chainHeadValue) {
    throw new Error("Existing encrypted store metadata is incomplete");
  }
  const key = deriveKey(passphrase, Buffer.from(salt, "base64url"));
  try {
    const keyCheck = decrypt(key, {
      ciphertext: metadata.get("key_check_ciphertext") ?? "",
      nonce: metadata.get("key_check_nonce") ?? "",
      tag: metadata.get("key_check_tag") ?? ""
    }, KEY_CHECK_AAD);
    if (keyCheck !== KEY_CHECK_VALUE) throw new Error("invalid key check value");
  } catch {
    key.fill(0);
    throw new Error("Unable to unlock the local store with the supplied passphrase");
  }

  const chainHead = decodeChainHead(key, chainHeadValue);
  let rows: EventRow[];
  try {
    rows = sqlite.prepare("SELECT * FROM events ORDER BY sequence").all() as EventRow[];
  } catch {
    key.fill(0);
    throw new Error("Existing encrypted store event table is missing or unreadable");
  }
  let expectedPreviousHash = GENESIS_HASH;
  for (const row of rows) {
    if (row.previous_hash !== expectedPreviousHash) {
      key.fill(0);
      throw new Error(`Event chain is broken at sequence ${row.sequence}`);
    }
    const rowWithoutHash: Omit<EventRow, "sequence" | "event_hash"> = {
      event_id: row.event_id,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.aggregate_id,
      event_type: row.event_type,
      schema_version: row.schema_version,
      occurred_at: row.occurred_at,
      payload_ciphertext: row.payload_ciphertext,
      payload_nonce: row.payload_nonce,
      payload_tag: row.payload_tag,
      previous_hash: row.previous_hash
    };
    if (computeEventHash(rowWithoutHash) !== row.event_hash) {
      key.fill(0);
      throw new Error(`Event hash is invalid at sequence ${row.sequence}`);
    }
    try {
      const aad = eventAad({
        eventId: row.event_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        occurredAt: row.occurred_at
      });
      JSON.parse(decrypt(key, {
        ciphertext: row.payload_ciphertext,
        nonce: row.payload_nonce,
        tag: row.payload_tag
      }, aad));
    } catch {
      key.fill(0);
      throw new Error(`Encrypted event payload cannot be authenticated at sequence ${row.sequence}`);
    }
    expectedPreviousHash = row.event_hash;
  }
  if (chainHead.eventCount !== rows.length || chainHead.headHash !== expectedPreviousHash) {
    key.fill(0);
    throw new Error("Event history does not match the authenticated chain head");
  }
  return key;
}

export class EncryptedEventStore {
  private constructor(
    private readonly databasePath: string,
    private readonly sqlite: BetterSqlite3.Database,
    private readonly db: Kysely<StoreDatabase>,
    private readonly key: Buffer
  ) {}

  public static async open(databasePath: string, passphrase: string): Promise<EncryptedEventStore> {
    const resolvedPath = path.resolve(databasePath);
    const existingStore = existsSync(resolvedPath) && statSync(resolvedPath).size > 0;
    if (passphrase.length < 12) {
      throw new Error("Local store passphrase must contain at least 12 characters");
    }
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const sqlite = new BetterSqlite3(resolvedPath);
    let key: Buffer | null = null;
    let db: Kysely<StoreDatabase> | null = null;
    let adoptedDatabaseId: string | null = null;
    try {
      if (existingStore) {
        key = authenticateExistingStore(sqlite, passphrase);
        const metadata = readExistingMetadata(sqlite);
        const salt = metadata.get("encryption_salt")!;
        adoptedDatabaseId = metadata.get("database_id") ?? databaseIdFromSalt(salt);
        if (!/^DB-[0-9a-f-]{36}$/.test(adoptedDatabaseId)) {
          throw new Error("Existing encrypted store database id is invalid");
        }
        const appliedBeforeMigration = listStoreMigrations(sqlite);
        const migrationVersions = appliedBeforeMigration.length > 0
          ? appliedBeforeMigration.map((migration) => migration.version)
          : [1];
        if ((migrationVersions.at(-1) ?? 0) < LATEST_STORE_MIGRATION) {
          const chainHead = decodeChainHead(key, metadata.get("event_chain_head")!);
          const image = sqlite.serialize();
          try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "");
            const backupPath = path.join(
              path.dirname(resolvedPath),
              "backups",
              `pre-migration-v${migrationVersions.at(-1)}-to-v${LATEST_STORE_MIGRATION}-${timestamp}-${randomUUID()}.vocationbak`
            );
            const { createEncryptedBackupFromImage } = await import("./encrypted-backup.js");
            createEncryptedBackupFromImage({
              database: image,
              backupPath,
              backupPassphrase: passphrase,
              databaseId: adoptedDatabaseId,
              eventCount: chainHead.eventCount,
              eventChainHead: chainHead.headHash,
              migrationVersions
            });
          } finally {
            image.fill(0);
          }
        }
      }

      applyStoreMigrations(sqlite);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      sqlite.pragma("synchronous = FULL");
      sqlite.pragma("busy_timeout = 5000");
      db = new Kysely<StoreDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });

      if (!existingStore) {
        const salt = randomBytes(16);
        key = deriveKey(passphrase, salt);
        const check = encrypt(key, KEY_CHECK_VALUE, KEY_CHECK_AAD);
        await db.insertInto("metadata").values([
          { key: "encryption_salt", value: salt.toString("base64url") },
          { key: "key_check_ciphertext", value: check.ciphertext },
          { key: "key_check_nonce", value: check.nonce },
          { key: "key_check_tag", value: check.tag },
          { key: "database_id", value: `DB-${randomUUID()}` },
          {
            key: "event_chain_head",
            value: encodeChainHead(key, { eventCount: 0, headHash: GENESIS_HASH })
          }
        ]).execute();
      } else {
        const databaseId = await db.selectFrom("metadata").select("value")
          .where("key", "=", "database_id")
          .executeTakeFirst();
        if (!databaseId) {
          await db.insertInto("metadata").values({
            key: "database_id",
            value: adoptedDatabaseId ?? `DB-${randomUUID()}`
          }).execute();
        }
      }

      try {
        chmodSync(resolvedPath, 0o600);
      } catch {
        // Windows ACLs are managed by the operating system rather than POSIX mode bits.
      }
      return new EncryptedEventStore(resolvedPath, sqlite, db, key!);
    } catch (error) {
      key?.fill(0);
      if (db) {
        await db.destroy();
      } else if (sqlite.open) {
        sqlite.close();
      }
      throw error;
    }
  }

  public path(): string {
    return this.databasePath;
  }

  public async append<T>(input: AppendEventInput<T>): Promise<StoredEvent<T>> {
    assertIdentifier(input.aggregateType, "Aggregate type");
    assertIdentifier(input.aggregateId, "Aggregate id");
    assertIdentifier(input.eventType, "Event type");
    assertSchemaVersion(input.schemaVersion);
    const occurredAt = (input.occurredAt ?? new Date()).toISOString();
    const eventId = input.eventId ?? `EVT-${randomUUID()}`;
    assertIdentifier(eventId, "Event id");
    const aadInput = {
      eventId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      schemaVersion: input.schemaVersion,
      occurredAt
    };
    const encrypted = encrypt(this.key, stableStringify(input.payload), eventAad(aadInput));
    const expectedHeadRow = await this.db.selectFrom("metadata").select("value").where("key", "=", "event_chain_head").executeTakeFirstOrThrow();
    const expectedHead = decodeChainHead(this.key, expectedHeadRow.value);

    return this.db.transaction().execute(async (transaction) => {
      const previous = await transaction.selectFrom("events").select("event_hash").orderBy("sequence", "desc").limit(1).executeTakeFirst();
      const countRow = await transaction.selectFrom("events").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
      const currentCount = Number(countRow.count);
      const currentHash = previous?.event_hash ?? GENESIS_HASH;
      if (currentCount !== expectedHead.eventCount || currentHash !== expectedHead.headHash) {
        throw new Error("Event chain head does not match stored event history");
      }
      const rowWithoutHash: Omit<EventRow, "sequence" | "event_hash"> = {
        event_id: eventId,
        aggregate_type: input.aggregateType,
        aggregate_id: input.aggregateId,
        event_type: input.eventType,
        schema_version: input.schemaVersion,
        occurred_at: occurredAt,
        payload_ciphertext: encrypted.ciphertext,
        payload_nonce: encrypted.nonce,
        payload_tag: encrypted.tag,
        previous_hash: previous?.event_hash ?? GENESIS_HASH
      };
      const eventHash = computeEventHash(rowWithoutHash);
      const insert = await transaction.insertInto("events").values({ ...rowWithoutHash, event_hash: eventHash }).executeTakeFirstOrThrow();
      await transaction.updateTable("metadata").set({
        value: encodeChainHead(this.key, { eventCount: currentCount + 1, headHash: eventHash })
      }).where("key", "=", "event_chain_head").executeTakeFirstOrThrow();
      const sequence = Number(insert.insertId);
      return {
        sequence,
        eventId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        schemaVersion: input.schemaVersion,
        occurredAt,
        previousHash: rowWithoutHash.previous_hash,
        eventHash,
        payload: input.payload
      };
    });
  }

  public async readAll<T = unknown>(): Promise<StoredEvent<T>[]> {
    const snapshot = await this.db.transaction().execute(async (transaction) => {
      const rows = await transaction.selectFrom("events").selectAll().orderBy("sequence", "asc").execute();
      const head = await transaction.selectFrom("metadata").select("value").where("key", "=", "event_chain_head").executeTakeFirst();
      if (!head) throw new Error("Encrypted event chain head is missing");
      return { rows, chainHead: decodeChainHead(this.key, head.value) };
    });
    const rows = snapshot.rows;
    const events: StoredEvent<T>[] = [];
    let expectedPreviousHash = GENESIS_HASH;
    for (const row of rows) {
      if (row.previous_hash !== expectedPreviousHash) {
        throw new Error(`Event chain is broken at sequence ${row.sequence}`);
      }
      const rowWithoutHash: Omit<EventRow, "sequence" | "event_hash"> = {
        event_id: row.event_id,
        aggregate_type: row.aggregate_type,
        aggregate_id: row.aggregate_id,
        event_type: row.event_type,
        schema_version: row.schema_version,
        occurred_at: row.occurred_at,
        payload_ciphertext: row.payload_ciphertext,
        payload_nonce: row.payload_nonce,
        payload_tag: row.payload_tag,
        previous_hash: row.previous_hash
      };
      if (computeEventHash(rowWithoutHash) !== row.event_hash) {
        throw new Error(`Event hash is invalid at sequence ${row.sequence}`);
      }
      const aad = eventAad({
        eventId: row.event_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        occurredAt: row.occurred_at
      });
      let payload: T;
      try {
        payload = JSON.parse(decrypt(this.key, {
          ciphertext: row.payload_ciphertext,
          nonce: row.payload_nonce,
          tag: row.payload_tag
        }, aad)) as T;
      } catch {
        throw new Error(`Encrypted event payload cannot be authenticated at sequence ${row.sequence}`);
      }
      events.push({
        sequence: row.sequence,
        eventId: row.event_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        occurredAt: row.occurred_at,
        previousHash: row.previous_hash,
        eventHash: row.event_hash,
        payload
      });
      expectedPreviousHash = row.event_hash;
    }
    if (snapshot.chainHead.eventCount !== rows.length || snapshot.chainHead.headHash !== expectedPreviousHash) {
      throw new Error("Event history does not match the authenticated chain head");
    }
    return events;
  }

  public async readAggregate<T = unknown>(aggregateType: string, aggregateId: string): Promise<StoredEvent<T>[]> {
    const events = await this.readAll<T>();
    return events.filter((event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId);
  }

  public async saveSnapshot<T>(
    aggregateType: string,
    aggregateId: string,
    version: number,
    lastEventHash: string,
    payload: T,
    now = new Date()
  ): Promise<void> {
    assertIdentifier(aggregateType, "Aggregate type");
    assertIdentifier(aggregateId, "Aggregate id");
    assertSchemaVersion(version);
    const aggregateEvents = await this.readAggregate(aggregateType, aggregateId);
    const checkpoint = aggregateEvents[version - 1];
    if (!checkpoint || checkpoint.eventHash !== lastEventHash) {
      throw new Error("Snapshot checkpoint does not match the aggregate event chain");
    }
    const existing = await this.db.selectFrom("snapshots").select("version")
      .where("aggregate_type", "=", aggregateType)
      .where("aggregate_id", "=", aggregateId)
      .executeTakeFirst();
    if (existing && version < existing.version) {
      throw new Error("Snapshot version rollback is not allowed");
    }
    const aad = snapshotAad({ aggregateType, aggregateId, version, lastEventHash });
    const encrypted = encrypt(this.key, stableStringify(payload), aad);
    await this.db.insertInto("snapshots").values({
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      version,
      created_at: now.toISOString(),
      last_event_hash: lastEventHash,
      payload_ciphertext: encrypted.ciphertext,
      payload_nonce: encrypted.nonce,
      payload_tag: encrypted.tag
    }).onConflict((conflict) => conflict.columns(["aggregate_type", "aggregate_id"]).doUpdateSet({
      version,
      created_at: now.toISOString(),
      last_event_hash: lastEventHash,
      payload_ciphertext: encrypted.ciphertext,
      payload_nonce: encrypted.nonce,
      payload_tag: encrypted.tag
    })).execute();
  }

  public async loadSnapshot<T>(aggregateType: string, aggregateId: string): Promise<StoredSnapshot<T> | null> {
    const row = await this.db.selectFrom("snapshots").selectAll()
      .where("aggregate_type", "=", aggregateType)
      .where("aggregate_id", "=", aggregateId)
      .executeTakeFirst();
    if (!row) return null;
    const aggregateEvents = await this.readAggregate(aggregateType, aggregateId);
    if (aggregateEvents[row.version - 1]?.eventHash !== row.last_event_hash) {
      throw new Error(`Snapshot checkpoint is not present in the event chain for ${aggregateType}:${aggregateId}`);
    }
    const aad = snapshotAad({
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      version: row.version,
      lastEventHash: row.last_event_hash
    });
    try {
      const payload = JSON.parse(decrypt(this.key, {
        ciphertext: row.payload_ciphertext,
        nonce: row.payload_nonce,
        tag: row.payload_tag
      }, aad)) as T;
      return {
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        version: row.version,
        createdAt: row.created_at,
        lastEventHash: row.last_event_hash,
        payload
      };
    } catch {
      throw new Error(`Encrypted snapshot cannot be authenticated for ${aggregateType}:${aggregateId}`);
    }
  }

  public async readEvent<T = unknown>(eventId: string): Promise<StoredEvent<T> | null> {
    assertIdentifier(eventId, "Event id");
    return (await this.readAll<T>()).find((event) => event.eventId === eventId) ?? null;
  }

  public migrations(): AppliedMigration[] {
    return listStoreMigrations(this.sqlite);
  }

  public async chainHead(): Promise<ChainHead> {
    const row = await this.db.selectFrom("metadata").select("value")
      .where("key", "=", "event_chain_head")
      .executeTakeFirst();
    if (!row) throw new Error("Encrypted event chain head is missing");
    return decodeChainHead(this.key, row.value);
  }

  public async databaseId(): Promise<string> {
    const row = await this.db.selectFrom("metadata").select("value")
      .where("key", "=", "database_id")
      .executeTakeFirst();
    if (!row || !/^DB-[0-9a-f-]{36}$/.test(row.value)) {
      throw new Error("Encrypted store database id is missing or invalid");
    }
    return row.value;
  }

  public async hasEvent(eventId: string): Promise<boolean> {
    assertIdentifier(eventId, "Event id");
    const row = await this.db.selectFrom("events").select("event_id")
      .where("event_id", "=", eventId)
      .executeTakeFirst();
    return row !== undefined;
  }

  public findLegacyImportReceipt(sourceDigest: string): LegacyImportReceipt | null {
    const row = this.sqlite.prepare(`
      SELECT
        source_digest AS sourceDigest,
        source_kind AS sourceKind,
        source_locator_hash AS sourceLocatorHash,
        event_id AS eventId,
        imported_at AS importedAt
      FROM legacy_import_receipts
      WHERE source_digest = ?
    `).get(sourceDigest) as LegacyImportReceipt | undefined;
    return row ?? null;
  }

  public recordLegacyImportReceipt(receipt: LegacyImportReceipt): void {
    this.sqlite.prepare(`
      INSERT INTO legacy_import_receipts(
        source_digest, source_kind, source_locator_hash, event_id, imported_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_digest) DO UPDATE SET
        source_kind = excluded.source_kind,
        source_locator_hash = excluded.source_locator_hash,
        event_id = excluded.event_id,
        imported_at = excluded.imported_at
    `).run(
      receipt.sourceDigest,
      receipt.sourceKind,
      receipt.sourceLocatorHash,
      receipt.eventId,
      receipt.importedAt
    );
  }

  public findAuthorityReceipt(requestId: string): AuthorityReceipt | null {
    assertIdentifier(requestId, "Authority request id");
    const row = this.sqlite.prepare(`
      SELECT
        request_id AS requestId,
        request_hash AS requestHash,
        operation,
        event_id AS eventId,
        response_hash AS responseHash,
        completed_at AS completedAt
      FROM authority_receipts
      WHERE request_id = ?
    `).get(requestId) as AuthorityReceipt | undefined;
    return row ?? null;
  }

  public recordAuthorityReceipt(receipt: AuthorityReceipt): void {
    assertIdentifier(receipt.requestId, "Authority request id");
    this.sqlite.prepare(`
      INSERT INTO authority_receipts(
        request_id, request_hash, operation, event_id, response_hash, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      receipt.requestId,
      receipt.requestHash,
      receipt.operation,
      receipt.eventId,
      receipt.responseHash,
      receipt.completedAt
    );
  }

  public saveSignedCheckpoint(checkpoint: SignedCheckpointRecord): void {
    this.sqlite.prepare(`
      INSERT INTO signed_checkpoints(
        checkpoint_id, database_id, schema_version, event_count, head_hash, created_at, device_id, key_id,
        previous_checkpoint_digest, public_key_pem, signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.checkpointId,
      checkpoint.databaseId,
      checkpoint.schemaVersion,
      checkpoint.eventCount,
      checkpoint.headHash,
      checkpoint.createdAt,
      checkpoint.deviceId,
      checkpoint.keyId,
      checkpoint.previousCheckpointDigest,
      checkpoint.publicKeyPem,
      checkpoint.signature
    );
  }

  public listSignedCheckpoints(): SignedCheckpointRecord[] {
    return this.sqlite.prepare(`
      SELECT
        checkpoint_id AS checkpointId,
        database_id AS databaseId,
        schema_version AS schemaVersion,
        event_count AS eventCount,
        head_hash AS headHash,
        created_at AS createdAt,
        device_id AS deviceId,
        key_id AS keyId,
        previous_checkpoint_digest AS previousCheckpointDigest,
        public_key_pem AS publicKeyPem,
        signature
      FROM signed_checkpoints
      ORDER BY event_count, created_at
    `).all() as SignedCheckpointRecord[];
  }

  public async createDatabaseSnapshot(destinationPath: string): Promise<void> {
    const resolvedDestination = path.resolve(destinationPath);
    if (resolvedDestination === this.databasePath) {
      throw new Error("Database snapshot destination must differ from the active store");
    }
    mkdirSync(path.dirname(resolvedDestination), { recursive: true });
    await this.sqlite.backup(resolvedDestination);
    try {
      chmodSync(resolvedDestination, 0o600);
    } catch {
      // Windows ACLs are managed by the operating system rather than POSIX mode bits.
    }
  }

  public serializeDatabase(): Buffer {
    return this.sqlite.serialize();
  }

  public async verifyIntegrity(): Promise<{ valid: true; eventCount: number; head: ChainHead }> {
    const row = this.sqlite.pragma("integrity_check", { simple: true });
    if (row !== "ok") throw new Error(`SQLite integrity check failed: ${String(row)}`);
    const events = await this.readAll();
    return { valid: true, eventCount: events.length, head: await this.chainHead() };
  }

  public async close(): Promise<void> {
    this.key.fill(0);
    await this.db.destroy();
    if (this.sqlite.open) this.sqlite.close();
  }
}
