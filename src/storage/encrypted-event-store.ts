import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { Generated, Kysely, SqliteDialect } from "kysely";
import { sha256, stableStringify } from "../hash.js";

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

interface ChainHead {
  eventCount: number;
  headHash: string;
}

export interface AppendEventInput<T> {
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

export class EncryptedEventStore {
  private constructor(
    private readonly databasePath: string,
    private readonly sqlite: BetterSqlite3.Database,
    private readonly db: Kysely<StoreDatabase>,
    private readonly key: Buffer
  ) {}

  public static async open(databasePath: string, passphrase: string): Promise<EncryptedEventStore> {
    const resolvedPath = path.resolve(databasePath);
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const sqlite = new BetterSqlite3(resolvedPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("synchronous = FULL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        payload_nonce TEXT NOT NULL,
        payload_tag TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_type, aggregate_id, sequence);
      CREATE TABLE IF NOT EXISTS snapshots (
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_event_hash TEXT NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        payload_nonce TEXT NOT NULL,
        payload_tag TEXT NOT NULL,
        PRIMARY KEY (aggregate_type, aggregate_id)
      );
    `);
    try {
      chmodSync(resolvedPath, 0o600);
    } catch {
      // Windows ACLs are managed by the operating system rather than POSIX mode bits.
    }

    const db = new Kysely<StoreDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
    let saltValue = await db.selectFrom("metadata").select("value").where("key", "=", "encryption_salt").executeTakeFirst();
    if (!saltValue) {
      const salt = randomBytes(16).toString("base64url");
      await db.insertInto("metadata").values({ key: "encryption_salt", value: salt }).execute();
      saltValue = { value: salt };
    }
    const key = deriveKey(passphrase, Buffer.from(saltValue.value, "base64url"));

    const checkRows = await db
      .selectFrom("metadata")
      .select(["key", "value"])
      .where("key", "in", ["key_check_ciphertext", "key_check_nonce", "key_check_tag"])
      .execute();
    const checks = new Map(checkRows.map((row) => [row.key, row.value]));
    const newKeyCheck = checks.size === 0;
    if (newKeyCheck) {
      const check = encrypt(key, KEY_CHECK_VALUE, KEY_CHECK_AAD);
      await db.insertInto("metadata").values([
        { key: "key_check_ciphertext", value: check.ciphertext },
        { key: "key_check_nonce", value: check.nonce },
        { key: "key_check_tag", value: check.tag }
      ]).execute();
    } else {
      try {
        const value = decrypt(
          key,
          {
            ciphertext: checks.get("key_check_ciphertext") ?? "",
            nonce: checks.get("key_check_nonce") ?? "",
            tag: checks.get("key_check_tag") ?? ""
          },
          KEY_CHECK_AAD
        );
        if (value !== KEY_CHECK_VALUE) throw new Error("invalid key check value");
      } catch {
        key.fill(0);
        await db.destroy();
        throw new Error("Unable to unlock the local store with the supplied passphrase");
      }
    }

    const chainHeadRow = await db.selectFrom("metadata").select("value").where("key", "=", "event_chain_head").executeTakeFirst();
    if (!chainHeadRow) {
      const countRow = await db.selectFrom("events").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
      if (!newKeyCheck || Number(countRow.count) !== 0) {
        key.fill(0);
        await db.destroy();
        throw new Error("Encrypted event chain head is missing");
      }
      await db.insertInto("metadata").values({
        key: "event_chain_head",
        value: encodeChainHead(key, { eventCount: 0, headHash: GENESIS_HASH })
      }).execute();
    } else {
      try {
        decodeChainHead(key, chainHeadRow.value);
      } catch (error) {
        key.fill(0);
        await db.destroy();
        throw error;
      }
    }
    return new EncryptedEventStore(resolvedPath, sqlite, db, key);
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
    const eventId = `EVT-${randomUUID()}`;
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

  public async close(): Promise<void> {
    this.key.fill(0);
    await this.db.destroy();
    if (this.sqlite.open) this.sqlite.close();
  }
}
