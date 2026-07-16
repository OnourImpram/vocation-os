import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256, stableStringify } from "../../src/hash.js";
import { createSignedNetworkAccessGrant } from "../../src/discovery/network-access-grant.js";
import type { EgressManifest, NetworkAccessGrant } from "../../src/discovery/governance.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import {
  NETWORK_ACCESS_CONSUMPTION_AGGREGATE_TYPE,
  NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE,
  NETWORK_ACCESS_GRANT_AGGREGATE_TYPE,
  NETWORK_ACCESS_GRANT_EVENT_TYPE,
  NetworkAccessGrantRepository,
  PersistentGovernedRateGate,
  computeNetworkAccessConsumptionId
} from "../../src/storage/network-access-grant-repository.js";

const PASSPHRASE = "network access repository test passphrase";
const BASE_TIME = Date.parse("2026-07-14T10:00:00.000Z");
const signingKey = generateKeyPairSync("ed25519").privateKey;

function manifest(overrides: Partial<EgressManifest> = {}): EgressManifest {
  return {
    manifestId: "egress:test-provider",
    providerId: "test-provider",
    version: "1.0.0",
    allowedHosts: ["api.example.com"],
    allowedPorts: [443],
    allowedPathPrefixes: ["/jobs"],
    allowedMethods: ["GET"],
    allowedRequestHeaders: ["accept"],
    redirectPolicy: { maxRedirects: 1, allowCrossHost: false },
    responsePolicy: {
      allowedStatusRanges: [{ min: 200, max: 299 }],
      allowedContentTypes: ["application/json"],
      requireContentType: true,
      maxBodyBytes: 1_024,
      timeoutMs: 1_000
    },
    ratePolicy: { maxRequests: 10, windowMs: 60_000 },
    cachePolicy: { ttlMs: 60_000, methods: ["GET"] },
    grantPolicy: { maxTtlMs: 3_600_000, maxRequests: 100, requireExactHosts: true },
    ...overrides
  };
}

function grant(overrides: Partial<NetworkAccessGrant> = {}): NetworkAccessGrant {
  return {
    grantId: "NAG-REPOSITORY-GRANT-0001",
    subject: "discovery-authority",
    purpose: "retrieve governed provider records",
    providerId: "test-provider",
    manifestId: "egress:test-provider",
    manifestVersion: "1.0.0",
    issuedAt: "2026-07-14T09:55:00.000Z",
    expiresAt: "2026-07-14T10:30:00.000Z",
    allowedHosts: ["api.example.com"],
    allowedMethods: ["GET"],
    requestBudget: 5,
    ...overrides
  };
}

function signedGrant(overrides: Partial<NetworkAccessGrant> = {}) {
  return createSignedNetworkAccessGrant(grant(overrides), {
    approvedBy: "authority:network",
    keyId: "KEY-NETWORK-0001",
    privateKey: signingKey
  });
}

describe("NetworkAccessGrantRepository and PersistentGovernedRateGate", () => {
  let root: string;
  let databasePath: string;
  let store: EncryptedEventStore | null;
  let repository: NetworkAccessGrantRepository;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vocation-network-grant-"));
    databasePath = path.join(root, "vocation.db");
    store = await EncryptedEventStore.open(databasePath, PASSPHRASE);
    repository = new NetworkAccessGrantRepository(store);
  });

  afterEach(async () => {
    const activeStore = store;
    store = null;
    await activeStore?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("stores an exact envelope idempotently and rejects grant id reuse with any different envelope", async () => {
    const eventStore = store!;
    const envelope = signedGrant();
    const first = await repository.save(envelope, new Date(BASE_TIME - 1_000));
    const replay = await repository.save(envelope, new Date(BASE_TIME));

    expect(replay).toEqual(first);
    expect((await eventStore.chainHead()).eventCount).toBe(1);

    await expect(repository.save(signedGrant({ purpose: "rebound purpose" }))).rejects.toThrow(
      "grant id was reused with a different digest or envelope"
    );

    const alteredSignature = Buffer.from(envelope.signature, "base64url");
    alteredSignature[0] = alteredSignature[0]! ^ 1;
    await expect(repository.save({
      ...envelope,
      signature: alteredSignature.toString("base64url")
    })).rejects.toThrow("grant id was reused with a different digest or envelope");
    expect((await eventStore.chainHead()).eventCount).toBe(1);
  });

  it("fails closed when a grant event in the authenticated chain violates the repository contract", async () => {
    const eventStore = store!;
    const envelope = signedGrant({ grantId: "NAG-MALFORMED-GRANT-0001" });
    await eventStore.append({
      eventId: "EVT-MALFORMED-GRANT-0001",
      aggregateType: NETWORK_ACCESS_GRANT_AGGREGATE_TYPE,
      aggregateId: envelope.grant.grantId,
      eventType: NETWORK_ACCESS_GRANT_EVENT_TYPE,
      schemaVersion: 1,
      occurredAt: new Date(BASE_TIME),
      payload: {
        envelope,
        envelopeHash: sha256(stableStringify(envelope)),
        trustedWithoutReplayValidation: true
      }
    });

    await expect(repository.get(envelope.grant.grantId)).rejects.toThrow(
      "grant event payload is malformed"
    );
  });

  it("serializes concurrent check and append across gate instances so a one request budget cannot race", async () => {
    const eventStore = store!;
    const envelope = signedGrant({ requestBudget: 1 });
    const providerManifest = manifest();
    await repository.save(envelope, new Date(BASE_TIME - 1_000));
    const firstGate = new PersistentGovernedRateGate(eventStore, repository);
    const secondGate = new PersistentGovernedRateGate(eventStore, repository);

    const decisions = await Promise.all([
      firstGate.consume({
        manifest: providerManifest,
        grant: envelope.grant,
        grantDigest: envelope.grantDigest,
        authorityRequestId: "REQ-RACE-REQUEST-0001",
        attemptIndex: 0,
        consumedAt: BASE_TIME
      }),
      secondGate.consume({
        manifest: providerManifest,
        grant: envelope.grant,
        grantDigest: envelope.grantDigest,
        authorityRequestId: "REQ-RACE-REQUEST-0002",
        attemptIndex: 0,
        consumedAt: BASE_TIME
      })
    ]);

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toEqual([
      { allowed: false, reason: "grant-budget", retryAfterMs: 0 }
    ]);
    const events = await eventStore.readAll();
    expect(events.filter((event) => event.eventType === NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE)).toHaveLength(1);
    expect(events.at(-1)?.eventType).toBe(NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE);
  });

  it("replays a persisted consumption after reopen without double counting and rejects changed bindings", async () => {
    const envelope = signedGrant({ requestBudget: 1 });
    const providerManifest = manifest();
    await repository.save(envelope, new Date(BASE_TIME - 1_000));
    const identity = {
      authorityRequestId: "REQ-REPLAY-REQUEST-0001",
      attemptIndex: 0,
      grantDigest: envelope.grantDigest
    } as const;
    const consumptionId = computeNetworkAccessConsumptionId(identity);
    const request = {
      manifest: providerManifest,
      grant: envelope.grant,
      ...identity,
      consumptionId,
      consumedAt: BASE_TIME
    };
    const firstGate = new PersistentGovernedRateGate(store!, repository);
    await expect(firstGate.consume(request)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    const committedHead = await store!.chainHead();

    const closingStore = store!;
    store = null;
    await closingStore.close();
    store = await EncryptedEventStore.open(databasePath, PASSPHRASE);
    repository = new NetworkAccessGrantRepository(store);
    const replayGate = new PersistentGovernedRateGate(store, repository);

    await expect(replayGate.consume(request)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    expect(await store.chainHead()).toEqual(committedHead);

    await expect(replayGate.consume({
      ...request,
      attemptIndex: 1
    })).rejects.toThrow("consumption id is not bound to its authority request, attempt, and grant digest");
    await expect(replayGate.consume({
      ...request,
      consumedAt: BASE_TIME + 1
    })).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    await expect(replayGate.consume({
      ...request,
      manifest: manifest({ ratePolicy: { maxRequests: 11, windowMs: 60_000 } })
    })).rejects.toThrow("consumption id was reused with a different binding");
    await expect(replayGate.consume({
      ...request,
      grantDigest: `sha256:${"0".repeat(64)}`
    })).rejects.toThrow("grant digest does not match the stored envelope");
    expect(await store.chainHead()).toEqual(committedHead);
  });

  it("enforces the persisted provider window and releases capacity exactly at the cutoff", async () => {
    const envelope = signedGrant({ requestBudget: 5 });
    const providerManifest = manifest({ ratePolicy: { maxRequests: 1, windowMs: 1_000 } });
    await repository.save(envelope, new Date(BASE_TIME - 1_000));
    const firstGate = new PersistentGovernedRateGate(store!, repository);
    await expect(firstGate.consume({
      manifest: providerManifest,
      grant: envelope.grant,
      grantDigest: envelope.grantDigest,
      authorityRequestId: "REQ-WINDOW-REQUEST-0001",
      attemptIndex: 0,
      consumedAt: BASE_TIME
    })).resolves.toEqual({ allowed: true, retryAfterMs: 0 });

    const closingStore = store!;
    store = null;
    await closingStore.close();
    store = await EncryptedEventStore.open(databasePath, PASSPHRASE);
    repository = new NetworkAccessGrantRepository(store);
    const reopenedGate = new PersistentGovernedRateGate(store, repository);

    await expect(reopenedGate.consume({
      manifest: providerManifest,
      grant: envelope.grant,
      grantDigest: envelope.grantDigest,
      authorityRequestId: "REQ-WINDOW-REQUEST-0002",
      attemptIndex: 0,
      consumedAt: BASE_TIME + 500
    })).resolves.toEqual({
      allowed: false,
      reason: "provider-rate-limit",
      retryAfterMs: 500
    });
    await expect(reopenedGate.consume({
      manifest: providerManifest,
      grant: envelope.grant,
      grantDigest: envelope.grantDigest,
      authorityRequestId: "REQ-WINDOW-REQUEST-0003",
      attemptIndex: 0,
      consumedAt: BASE_TIME + 1_000
    })).resolves.toEqual({ allowed: true, retryAfterMs: 0 });

    const events = await store.readAll();
    expect(events.filter((event) => event.eventType === NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE)).toHaveLength(2);
  });

  it("rejects a rate event whose persisted consumption id is not derived from its full authority binding", async () => {
    const eventStore = store!;
    const envelope = signedGrant();
    const providerManifest = manifest();
    await repository.save(envelope, new Date(BASE_TIME - 1_000));
    const invalidConsumptionId = `NAC-${"0".repeat(64)}`;
    await eventStore.append({
      eventId: `EVT-${invalidConsumptionId}`,
      aggregateType: NETWORK_ACCESS_CONSUMPTION_AGGREGATE_TYPE,
      aggregateId: invalidConsumptionId,
      eventType: NETWORK_ACCESS_CONSUMPTION_EVENT_TYPE,
      schemaVersion: 1,
      occurredAt: new Date(BASE_TIME),
      payload: {
        consumption: {
          consumptionId: invalidConsumptionId,
          authorityRequestId: "REQ-MALFORMED-RATE-0001",
          attemptIndex: 0,
          grantId: envelope.grant.grantId,
          grantDigest: envelope.grantDigest,
          manifest: providerManifest,
          manifestHash: sha256(stableStringify(providerManifest)),
          consumedAt: BASE_TIME
        }
      }
    });

    const gate = new PersistentGovernedRateGate(eventStore, repository);
    await expect(gate.consume({
      manifest: providerManifest,
      grant: envelope.grant,
      grantDigest: envelope.grantDigest,
      authorityRequestId: "REQ-VALID-RATE-000001",
      attemptIndex: 0,
      consumedAt: BASE_TIME
    })).rejects.toThrow("consumption event identity is invalid");
  });
});
