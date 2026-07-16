import { sha256, stableStringify } from "../hash.js";
import {
  NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM,
  computeNetworkAccessGrantDigest,
  type SignedNetworkAccessGrantEnvelope
} from "../discovery/network-access-grant.js";
import {
  assertValidEgressManifest,
  validateNetworkAccessGrant,
  type EgressManifest,
  type NetworkAccessGrant
} from "../discovery/governance.js";
import type {
  GovernedRateGate,
  GovernedRateGateDecision,
  GovernedRateGateRequest
} from "../discovery/governed-fetch-broker.js";
import type { EncryptedEventStore, StoredEvent } from "./encrypted-event-store.js";

export const NETWORK_ACCESS_GRANT_AGGREGATE_TYPE = "network-access-grant" as const;
export const NETWORK_ACCESS_GRANT_EVENT_TYPE = "network-access-grant-recorded" as const;
export const NETWORK_ACCESS_CONSUMPTION_AGGREGATE_TYPE = "network-access-consumption" as const;
export const NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE = "network-access-consumed" as const;

const EVENT_SCHEMA_VERSION = 1;
const CONSUMPTION_CONTEXT = "vocation-os/network-access-consumption/v1";
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GRANT_ID_PATTERN = /^NAG-[A-Z0-9][A-Z0-9-]{7,127}$/;
const AUTHORITY_REQUEST_ID_PATTERN = /^REQ-[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const CONSUMPTION_ID_PATTERN = /^NAC-[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

const ENVELOPE_KEYS = [
  "grant",
  "approvedBy",
  "keyId",
  "signatureAlgorithm",
  "grantDigest",
  "signature"
] as const;
const GRANT_EVENT_PAYLOAD_KEYS = ["envelope", "envelopeHash"] as const;
const CONSUMPTION_KEYS = [
  "consumptionId",
  "authorityRequestId",
  "attemptIndex",
  "grantId",
  "grantDigest",
  "manifest",
  "manifestHash",
  "consumedAt"
] as const;

export interface StoredNetworkAccessGrantRecord {
  readonly grantId: string;
  readonly grantDigest: string;
  readonly envelope: SignedNetworkAccessGrantEnvelope;
  readonly envelopeHash: string;
  readonly recordedAt: string;
  readonly eventId: string;
  readonly eventHash: string;
}

export interface NetworkAccessConsumptionIdentity {
  readonly authorityRequestId: string;
  readonly attemptIndex: number;
  readonly grantDigest: string;
}

export interface PersistentGovernedRateGateRequest extends GovernedRateGateRequest {
  readonly authorityRequestId: string;
  readonly attemptIndex: number;
  readonly grantDigest?: string;
  readonly consumptionId?: string;
}

export interface NetworkAccessConsumptionRecord {
  readonly consumptionId: string;
  readonly authorityRequestId: string;
  readonly attemptIndex: number;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly manifest: EgressManifest;
  readonly manifestHash: string;
  readonly consumedAt: number;
}

interface GrantEventPayload {
  readonly envelope: SignedNetworkAccessGrantEnvelope;
  readonly envelopeHash: string;
}

interface ConsumptionEventPayload {
  readonly consumption: NetworkAccessConsumptionRecord;
}

class MutationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const STORE_COORDINATORS = new WeakMap<EncryptedEventStore, MutationCoordinator>();

function coordinatorFor(store: EncryptedEventStore): MutationCoordinator {
  const existing = STORE_COORDINATORS.get(store);
  if (existing) return existing;
  const coordinator = new MutationCoordinator();
  STORE_COORDINATORS.set(store, coordinator);
  return coordinator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return stableStringify(Object.keys(value).sort()) === stableStringify([...keys].sort());
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function canonicalJsonClone<T>(value: T, label: string): T {
  const seen = new Set<object>();
  let nodes = 0;

  const clone = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error(`${label} exceeds the JSON node limit`);
    if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds the JSON depth limit`);
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${label} contains a non-finite number`);
      return current;
    }
    if (typeof current !== "object") throw new Error(`${label} must contain only JSON-compatible values`);
    if (seen.has(current)) throw new Error(`${label} cannot contain circular values`);
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype || Object.getOwnPropertySymbols(current).length > 0) {
          throw new Error(`${label} contains a non-canonical array`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const elementKeys = Object.keys(descriptors).filter((key) => key !== "length");
        if (
          elementKeys.length !== current.length
          || elementKeys.some((key, index) => key !== String(index))
        ) throw new Error(`${label} contains a sparse or extended array`);
        const result: unknown[] = [];
        for (const key of elementKeys) {
          const descriptor = descriptors[key];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new Error(`${label} contains an array accessor`);
          }
          result.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }

      const prototype = Object.getPrototypeOf(current) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} must contain only plain objects`);
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new Error(`${label} cannot contain symbol properties`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error(`${label} contains an accessor or hidden property`);
        }
        result[key] = clone(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(current);
    }
  };

  return clone(value, 0) as T;
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO date-time`);
  }
}

function canonicalDate(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} is invalid`);
  return value.toISOString();
}

function assertGrantId(value: string): void {
  if (!GRANT_ID_PATTERN.test(value)) throw new Error("Network access grant id is invalid");
}

function assertAuthorityRequestId(value: string): void {
  if (!AUTHORITY_REQUEST_ID_PATTERN.test(value)) {
    throw new Error("Network access consumption authority request id is invalid");
  }
}

function assertAttemptIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Network access consumption attempt index is invalid");
  }
}

function assertConsumedAt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new Error("Network access consumption time is invalid");
  }
}

function assertCanonicalSignature(value: string): void {
  if (!BASE64URL_PATTERN.test(value)) throw new Error("Network access grant signature encoding is invalid");
  const signature = Buffer.from(value, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== value) {
    throw new Error("Network access grant signature encoding is invalid");
  }
}

function canonicalEnvelope(value: unknown): SignedNetworkAccessGrantEnvelope {
  const cloned = canonicalJsonClone(value, "Signed network access grant envelope");
  if (!isRecord(cloned) || !hasExactKeys(cloned, ENVELOPE_KEYS)) {
    throw new Error("Signed network access grant envelope is malformed");
  }
  if (
    typeof cloned["approvedBy"] !== "string"
    || typeof cloned["keyId"] !== "string"
    || cloned["signatureAlgorithm"] !== NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM
    || typeof cloned["grantDigest"] !== "string"
    || !HASH_PATTERN.test(cloned["grantDigest"])
    || typeof cloned["signature"] !== "string"
  ) throw new Error("Signed network access grant envelope fields are invalid");
  assertCanonicalSignature(cloned["signature"]);

  const envelope = cloned as unknown as SignedNetworkAccessGrantEnvelope;
  const expectedDigest = computeNetworkAccessGrantDigest(envelope.grant, {
    approvedBy: envelope.approvedBy,
    keyId: envelope.keyId,
    signatureAlgorithm: NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM
  });
  if (envelope.grantDigest !== expectedDigest) {
    throw new Error("Signed network access grant digest does not match its canonical envelope");
  }
  return deepFreeze(envelope);
}

function grantEventId(grantId: string): string {
  assertGrantId(grantId);
  return `EVT-NAG-${sha256(stableStringify({ grantId })).slice("sha256:".length)}`;
}

export function computeNetworkAccessConsumptionId(identity: NetworkAccessConsumptionIdentity): string {
  assertAuthorityRequestId(identity.authorityRequestId);
  assertAttemptIndex(identity.attemptIndex);
  if (!HASH_PATTERN.test(identity.grantDigest)) {
    throw new Error("Network access consumption grant digest is invalid");
  }
  const digest = sha256(stableStringify({
    context: CONSUMPTION_CONTEXT,
    authorityRequestId: identity.authorityRequestId,
    attemptIndex: identity.attemptIndex,
    grantDigest: identity.grantDigest
  }));
  return `NAC-${digest.slice("sha256:".length)}`;
}

export const createNetworkAccessConsumptionId = computeNetworkAccessConsumptionId;

function consumptionEventId(consumptionId: string): string {
  if (!CONSUMPTION_ID_PATTERN.test(consumptionId)) {
    throw new Error("Network access consumption id is invalid");
  }
  return `EVT-${consumptionId}`;
}

function grantRecordFromEvent(event: StoredEvent<unknown>): StoredNetworkAccessGrantRecord {
  if (
    event.aggregateType !== NETWORK_ACCESS_GRANT_AGGREGATE_TYPE
    || event.eventType !== NETWORK_ACCESS_GRANT_EVENT_TYPE
    || event.schemaVersion !== EVENT_SCHEMA_VERSION
  ) throw new Error("Stored network access grant event contract is invalid");
  if (!isRecord(event.payload) || !hasExactKeys(event.payload, GRANT_EVENT_PAYLOAD_KEYS)) {
    throw new Error("Stored network access grant event payload is malformed");
  }
  const envelope = canonicalEnvelope(event.payload["envelope"]);
  const envelopeHash = event.payload["envelopeHash"];
  if (
    typeof envelopeHash !== "string"
    || !HASH_PATTERN.test(envelopeHash)
    || envelopeHash !== sha256(stableStringify(envelope))
  ) throw new Error("Stored network access grant envelope hash is invalid");
  const grantId = envelope.grant.grantId;
  if (
    event.aggregateId !== grantId
    || event.eventId !== grantEventId(grantId)
  ) throw new Error("Stored network access grant event is not bound to its grant id");
  assertCanonicalTimestamp(event.occurredAt, "Stored network access grant event time");
  return deepFreeze({
    grantId,
    grantDigest: envelope.grantDigest,
    envelope,
    envelopeHash,
    recordedAt: event.occurredAt,
    eventId: event.eventId,
    eventHash: event.eventHash
  });
}

function manifestIdentity(manifest: EgressManifest): string {
  return stableStringify({
    providerId: manifest.providerId,
    manifestId: manifest.manifestId,
    manifestVersion: manifest.version
  });
}

function assertGrantManifestBinding(
  grant: NetworkAccessGrant,
  manifest: EgressManifest,
  consumedAt: number,
  label: string
): void {
  const validation = validateNetworkAccessGrant(grant, manifest, new Date(consumedAt));
  if (!validation.valid) {
    throw new Error(`${label} is invalid: ${validation.errors.join("; ")}`);
  }
}

function consumptionFromEvent(event: StoredEvent<unknown>): NetworkAccessConsumptionRecord {
  if (
    event.aggregateType !== NETWORK_ACCESS_CONSUMPTION_AGGREGATE_TYPE
    || event.eventType !== NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE
    || event.schemaVersion !== EVENT_SCHEMA_VERSION
  ) throw new Error("Stored network access consumption event contract is invalid");
  if (!isRecord(event.payload) || !hasExactKeys(event.payload, ["consumption"])) {
    throw new Error("Stored network access consumption event payload is malformed");
  }
  const cloned = canonicalJsonClone(event.payload["consumption"], "Stored network access consumption");
  if (!isRecord(cloned) || !hasExactKeys(cloned, CONSUMPTION_KEYS)) {
    throw new Error("Stored network access consumption is malformed");
  }
  const {
    consumptionId,
    authorityRequestId,
    attemptIndex,
    grantId,
    grantDigest,
    manifestHash,
    consumedAt
  } = cloned;
  if (
    typeof consumptionId !== "string"
    || typeof authorityRequestId !== "string"
    || typeof attemptIndex !== "number"
    || typeof grantId !== "string"
    || typeof grantDigest !== "string"
    || typeof manifestHash !== "string"
    || typeof consumedAt !== "number"
  ) throw new Error("Stored network access consumption fields are invalid");
  assertAuthorityRequestId(authorityRequestId);
  assertAttemptIndex(attemptIndex);
  assertGrantId(grantId);
  if (!HASH_PATTERN.test(grantDigest)) throw new Error("Stored network access consumption grant digest is invalid");
  assertConsumedAt(consumedAt);

  const manifest = canonicalJsonClone(cloned["manifest"], "Stored network access consumption manifest");
  assertValidEgressManifest(manifest);
  if (!HASH_PATTERN.test(manifestHash) || manifestHash !== sha256(stableStringify(manifest))) {
    throw new Error("Stored network access consumption manifest hash is invalid");
  }
  const expectedConsumptionId = computeNetworkAccessConsumptionId({
    authorityRequestId,
    attemptIndex,
    grantDigest
  });
  if (
    consumptionId !== expectedConsumptionId
    || event.aggregateId !== consumptionId
    || event.eventId !== consumptionEventId(consumptionId)
  ) throw new Error("Stored network access consumption event identity is invalid");
  if (event.occurredAt !== new Date(consumedAt).toISOString()) {
    throw new Error("Stored network access consumption event time is invalid");
  }
  return deepFreeze({
    consumptionId,
    authorityRequestId,
    attemptIndex,
    grantId,
    grantDigest,
    manifest,
    manifestHash,
    consumedAt
  });
}

function consumptionReplayBinding(consumption: NetworkAccessConsumptionRecord): unknown {
  return {
    consumptionId: consumption.consumptionId,
    authorityRequestId: consumption.authorityRequestId,
    attemptIndex: consumption.attemptIndex,
    grantId: consumption.grantId,
    grantDigest: consumption.grantDigest,
    manifest: consumption.manifest,
    manifestHash: consumption.manifestHash
  };
}

export class NetworkAccessGrantRepository {
  private readonly mutations: MutationCoordinator;

  public constructor(private readonly store: EncryptedEventStore) {
    this.mutations = coordinatorFor(store);
  }

  private async records(): Promise<StoredNetworkAccessGrantRecord[]> {
    const events = (await this.store.readAll<unknown>()).filter(
      (event) => event.aggregateType === NETWORK_ACCESS_GRANT_AGGREGATE_TYPE
        || event.eventType === NETWORK_ACCESS_GRANT_EVENT_TYPE
    );
    const records: StoredNetworkAccessGrantRecord[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      const record = grantRecordFromEvent(event);
      if (seen.has(record.grantId)) {
        throw new Error(`Immutable network access grant ${record.grantId} has multiple stored events`);
      }
      seen.add(record.grantId);
      records.push(record);
    }
    return records;
  }

  public async get(grantId: string): Promise<StoredNetworkAccessGrantRecord | null> {
    assertGrantId(grantId);
    return (await this.records()).find((record) => record.grantId === grantId) ?? null;
  }

  public async getEnvelope(grantId: string): Promise<SignedNetworkAccessGrantEnvelope | null> {
    return (await this.get(grantId))?.envelope ?? null;
  }

  public async list(): Promise<StoredNetworkAccessGrantRecord[]> {
    return (await this.records()).sort((left, right) => left.grantId.localeCompare(right.grantId));
  }

  public save(
    envelopeValue: SignedNetworkAccessGrantEnvelope,
    now = new Date()
  ): Promise<StoredNetworkAccessGrantRecord> {
    return this.mutations.run(async () => {
      const envelope = canonicalEnvelope(envelopeValue);
      const recordedAt = canonicalDate(now, "Network access grant record time");
      const existing = (await this.records()).find((record) => record.grantId === envelope.grant.grantId);
      if (existing) {
        if (stableStringify(existing.envelope) !== stableStringify(envelope)) {
          throw new Error("Network access grant id was reused with a different digest or envelope");
        }
        return existing;
      }

      const eventId = grantEventId(envelope.grant.grantId);
      if (await this.store.readEvent(eventId)) {
        throw new Error("Network access grant deterministic event id is already bound to another event");
      }
      const event = await this.store.append<GrantEventPayload>({
        eventId,
        aggregateType: NETWORK_ACCESS_GRANT_AGGREGATE_TYPE,
        aggregateId: envelope.grant.grantId,
        eventType: NETWORK_ACCESS_GRANT_EVENT_TYPE,
        schemaVersion: EVENT_SCHEMA_VERSION,
        occurredAt: new Date(recordedAt),
        payload: {
          envelope,
          envelopeHash: sha256(stableStringify(envelope))
        }
      });
      return grantRecordFromEvent(event);
    });
  }

  public put(
    envelope: SignedNetworkAccessGrantEnvelope,
    now = new Date()
  ): Promise<StoredNetworkAccessGrantRecord> {
    return this.save(envelope, now);
  }
}

export class PersistentGovernedRateGate implements GovernedRateGate {
  private readonly grants: NetworkAccessGrantRepository;
  private readonly mutations: MutationCoordinator;

  public constructor(
    private readonly store: EncryptedEventStore,
    grants?: NetworkAccessGrantRepository
  ) {
    this.grants = grants ?? new NetworkAccessGrantRepository(store);
    this.mutations = coordinatorFor(store);
  }

  private async consumptions(
    grantRecords: readonly StoredNetworkAccessGrantRecord[]
  ): Promise<NetworkAccessConsumptionRecord[]> {
    const grantById = new Map(grantRecords.map((record) => [record.grantId, record]));
    const events = (await this.store.readAll<unknown>()).filter(
      (event) => event.aggregateType === NETWORK_ACCESS_CONSUMPTION_AGGREGATE_TYPE
        || event.eventType === NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE
    );
    const records: NetworkAccessConsumptionRecord[] = [];
    const byId = new Set<string>();
    const manifestHashes = new Map<string, string>();
    for (const event of events) {
      const consumption = consumptionFromEvent(event);
      if (byId.has(consumption.consumptionId)) {
        throw new Error(`Network access consumption ${consumption.consumptionId} has multiple stored events`);
      }
      byId.add(consumption.consumptionId);
      const grant = grantById.get(consumption.grantId);
      if (!grant || grant.grantDigest !== consumption.grantDigest) {
        throw new Error("Stored network access consumption is not bound to an immutable grant envelope");
      }
      assertGrantManifestBinding(
        grant.envelope.grant,
        consumption.manifest,
        consumption.consumedAt,
        "Stored network access consumption grant binding"
      );
      const key = manifestIdentity(consumption.manifest);
      const boundHash = manifestHashes.get(key);
      if (boundHash && boundHash !== consumption.manifestHash) {
        throw new Error("Stored network access consumptions rebind a provider manifest version");
      }
      manifestHashes.set(key, consumption.manifestHash);
      records.push(consumption);
    }
    return records;
  }

  private async consumeSerialized(
    request: GovernedRateGateRequest & Partial<PersistentGovernedRateGateRequest>
  ): Promise<GovernedRateGateDecision> {
    const authorityRequestId = request.authorityRequestId;
    const attemptIndex = request.attemptIndex;
    if (typeof authorityRequestId !== "string") {
      throw new Error("Persistent network access consumption requires an outer authority request id");
    }
    if (typeof attemptIndex !== "number") {
      throw new Error("Persistent network access consumption requires an attempt index");
    }
    assertAuthorityRequestId(authorityRequestId);
    assertAttemptIndex(attemptIndex);
    assertConsumedAt(request.consumedAt);

    const manifest = canonicalJsonClone(request.manifest, "Network access consumption manifest");
    assertValidEgressManifest(manifest);
    const grant = canonicalJsonClone(request.grant, "Network access consumption grant");
    if (typeof grant.grantId !== "string") throw new Error("Network access consumption grant id is invalid");
    assertGrantId(grant.grantId);

    const grantRecords = await this.grants.list();
    const storedGrant = grantRecords.find((record) => record.grantId === grant.grantId);
    if (!storedGrant) throw new Error("Network access consumption requires a stored signed grant envelope");
    if (request.grantDigest !== undefined) {
      if (typeof request.grantDigest !== "string" || request.grantDigest !== storedGrant.grantDigest) {
        throw new Error("Network access consumption grant digest does not match the stored envelope");
      }
    }
    if (stableStringify(grant) !== stableStringify(storedGrant.envelope.grant)) {
      throw new Error("Network access consumption grant does not match the stored envelope");
    }
    assertGrantManifestBinding(grant, manifest, request.consumedAt, "Network access consumption grant binding");

    const consumptionId = computeNetworkAccessConsumptionId({
      authorityRequestId,
      attemptIndex,
      grantDigest: storedGrant.grantDigest
    });
    if (request.consumptionId !== undefined) {
      if (typeof request.consumptionId !== "string" || request.consumptionId !== consumptionId) {
        throw new Error("Network access consumption id is not bound to its authority request, attempt, and grant digest");
      }
    }
    const manifestHash = sha256(stableStringify(manifest));
    const current = deepFreeze<NetworkAccessConsumptionRecord>({
      consumptionId,
      authorityRequestId,
      attemptIndex,
      grantId: grant.grantId,
      grantDigest: storedGrant.grantDigest,
      manifest,
      manifestHash,
      consumedAt: request.consumedAt
    });

    const consumptions = await this.consumptions(grantRecords);
    const replay = consumptions.find((consumption) => consumption.consumptionId === consumptionId);
    if (replay) {
      if (
        stableStringify(consumptionReplayBinding(replay))
        !== stableStringify(consumptionReplayBinding(current))
      ) {
        throw new Error("Network access consumption id was reused with a different binding");
      }
      return { allowed: true, retryAfterMs: 0 };
    }
    const eventId = consumptionEventId(consumptionId);
    if (await this.store.readEvent(eventId)) {
      throw new Error("Network access consumption deterministic event id is already bound to another event");
    }

    const sameManifest = consumptions.filter(
      (consumption) => manifestIdentity(consumption.manifest) === manifestIdentity(manifest)
    );
    const boundManifest = sameManifest[0];
    if (boundManifest && boundManifest.manifestHash !== manifestHash) {
      throw new Error("Network access consumption cannot rebind a provider manifest version");
    }
    const latestManifestConsumption = sameManifest.reduce(
      (latest, consumption) => Math.max(latest, consumption.consumedAt),
      -1
    );
    if (request.consumedAt < latestManifestConsumption) {
      throw new Error("Network access consumption time moved backwards for the provider manifest");
    }

    const usedByGrant = consumptions.filter(
      (consumption) => consumption.grantDigest === storedGrant.grantDigest
    ).length;
    if (usedByGrant >= storedGrant.envelope.grant.requestBudget) {
      return { allowed: false, reason: "grant-budget", retryAfterMs: 0 };
    }

    const cutoff = request.consumedAt - manifest.ratePolicy.windowMs;
    const active = sameManifest
      .map((consumption) => consumption.consumedAt)
      .filter((consumedAt) => consumedAt > cutoff)
      .sort((left, right) => left - right);
    if (active.length >= manifest.ratePolicy.maxRequests) {
      return {
        allowed: false,
        reason: "provider-rate-limit",
        retryAfterMs: Math.max(1, active[0]! + manifest.ratePolicy.windowMs - request.consumedAt)
      };
    }

    const event = await this.store.append<ConsumptionEventPayload>({
      eventId,
      aggregateType: NETWORK_ACCESS_CONSUMPTION_AGGREGATE_TYPE,
      aggregateId: consumptionId,
      eventType: NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE,
      schemaVersion: EVENT_SCHEMA_VERSION,
      occurredAt: new Date(request.consumedAt),
      payload: { consumption: current }
    });
    const persisted = consumptionFromEvent(event);
    if (stableStringify(persisted) !== stableStringify(current)) {
      throw new Error("Persisted network access consumption does not match the authorized binding");
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  public consume(request: PersistentGovernedRateGateRequest): Promise<GovernedRateGateDecision>;
  public consume(request: GovernedRateGateRequest): Promise<GovernedRateGateDecision>;
  public consume(request: GovernedRateGateRequest): Promise<GovernedRateGateDecision> {
    return this.mutations.run(() => this.consumeSerialized(
      request as GovernedRateGateRequest & Partial<PersistentGovernedRateGateRequest>
    ));
  }
}
