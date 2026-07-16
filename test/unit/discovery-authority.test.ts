import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import {
  GovernedFetchBroker,
  type BrokerClock,
  type GovernedFetchTransport
} from "../../src/discovery/governed-fetch-broker.js";
import { createSignedNetworkAccessGrant } from "../../src/discovery/network-access-grant.js";
import type { NetworkAccessGrant } from "../../src/discovery/governance.js";
import { MemoryCredentialStore } from "../../src/security/credential-store.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";

const PASSPHRASE = "governed discovery authority passphrase";
const NOW = new Date("2026-07-14T12:30:00.000Z");
const NOW_MS = NOW.getTime();
const DISCOVERY_URL = "https://boards-api.greenhouse.io/v1/boards/example/jobs";
const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 as const };

const RESPONSE_BODY = JSON.stringify({
  jobs: [{
    id: "greenhouse-record-1",
    title: "Clinical AI Researcher",
    company: "Example Research",
    url: "https://boards.greenhouse.io/example/jobs/greenhouse-record-1",
    description: "Build governed career decision systems.",
    location: "Remote",
    publishedAt: "2026-07-14T08:00:00.000Z"
  }]
});

function grant(requestBudget = 1): NetworkAccessGrant {
  return {
    grantId: `NAG-DISCOVERY-AUTHORITY-${requestBudget.toString().padStart(4, "0")}`,
    subject: "local-vocation-operator",
    purpose: "retrieve one governed Greenhouse fixture",
    providerId: "greenhouse",
    manifestId: "egress:greenhouse",
    manifestVersion: "1.0.0",
    issuedAt: "2026-07-14T12:25:00.000Z",
    expiresAt: "2026-07-14T13:00:00.000Z",
    allowedHosts: ["boards-api.greenhouse.io"],
    allowedMethods: ["GET"],
    requestBudget
  };
}

function discoveryPayload(grantId: string) {
  return {
    providerId: "greenhouse" as const,
    grantId,
    sourceKey: "greenhouse:example",
    url: DISCOVERY_URL,
    companyHint: "Example Research",
    headers: {},
    operatorScopedTarget: false
  };
}

describe("governed discovery daemon authority", () => {
  let root: string;
  let store: EncryptedEventStore;
  let authority: RuntimeAuthority;
  let transport: ReturnType<typeof vi.fn<GovernedFetchTransport>>;
  const signingKeys = generateKeyPairSync("ed25519");
  const keyId = "KEY-DISCOVERY-AUTHORITY-0001";
  const approvedBy = "operator:discovery";

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-discovery-authority-"));
    store = await EncryptedEventStore.open(path.join(root, "vocation.db"), PASSPHRASE);
    transport = vi.fn<GovernedFetchTransport>(async () => ({
      status: 200,
      headers: {
        get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null
      },
      body: new TextEncoder().encode(RESPONSE_BODY)
    }));
    const clock: BrokerClock = {
      now: () => NOW_MS,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle)
    };
    authority = new RuntimeAuthority(store, new MemoryCredentialStore(), root, null, {
      createGovernedDiscoveryBroker: ({ grantVerifier, rateGate }) => new GovernedFetchBroker({
        dns: { resolve: async () => [PUBLIC_ADDRESS] },
        fetch: transport,
        grantVerifier,
        rateGate,
        clock
      })
    });
    await authority.execute({
      id: "REQ-DISCOVERY-APPROVER-REGISTER-0001",
      operation: "approver-register",
      payload: {
        approvedBy,
        keyId,
        publicKeyPem: signingKeys.publicKey.export({ type: "spki", format: "pem" }).toString()
      }
    }, NOW);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function registerGrant(requestBudget = 1) {
    const envelope = createSignedNetworkAccessGrant(grant(requestBudget), {
      approvedBy,
      keyId,
      privateKey: signingKeys.privateKey
    });
    const response = await authority.execute({
      id: `REQ-NETWORK-GRANT-REGISTER-${requestBudget.toString().padStart(4, "0")}`,
      operation: "network-grant-register",
      payload: { envelope, scopeUrl: null }
    }, NOW);
    return { envelope, response };
  }

  it("registers a trusted grant and persists bounded discovery truth through the real broker", async () => {
    const { envelope, response: registered } = await registerGrant();
    expect(registered).toMatchObject({
      grantId: envelope.grant.grantId,
      grantDigest: envelope.grantDigest,
      providerId: "greenhouse",
      approvedBy,
      keyId,
      requestBudget: 1
    });

    const command = {
      id: "REQ-DISCOVERY-RUN-AUTHORITY-0001",
      operation: "discovery-run" as const,
      payload: discoveryPayload(envelope.grant.grantId)
    };
    const first = await authority.execute(command, NOW);
    expect(first).toMatchObject({
      providerId: "greenhouse",
      grantId: envelope.grant.grantId,
      grantDigest: envelope.grantDigest,
      endpointObservation: { domain: "source-observations", version: 1 },
      endpointLiveness: { domain: "liveness-assessments", version: 1 },
      postings: [{
        opportunity: { domain: "opportunities", version: 1 },
        observation: { domain: "source-observations", version: 1 },
        liveness: { domain: "liveness-assessments", version: 1 },
        truth: { domain: "opportunity-truth-records", version: 1 }
      }],
      dedupe: { domain: "dedupe-results", version: 1 },
      rejectionCount: 0,
      runHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
    expect(JSON.stringify(first)).not.toContain("Build governed career decision systems");
    expect(transport).toHaveBeenCalledTimes(1);

    await expect(authority.execute(command, new Date(NOW_MS + 60_000))).resolves.toEqual(first);
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(authority.execute({
      id: "REQ-NETWORK-GRANT-LIST-0001",
      operation: "network-grant-list",
      payload: { cursor: null, limit: 50 }
    }, NOW)).resolves.toMatchObject({
      items: [{ grantId: envelope.grant.grantId, grantDigest: envelope.grantDigest }],
      nextCursor: null,
      limit: 50,
      pageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
  });

  it("enforces the persisted grant budget across authority requests before transport", async () => {
    const { envelope } = await registerGrant();
    await authority.execute({
      id: "REQ-DISCOVERY-RUN-BUDGET-0001",
      operation: "discovery-run",
      payload: discoveryPayload(envelope.grant.grantId)
    }, NOW);
    const blocked = await authority.execute({
      id: "REQ-DISCOVERY-RUN-BUDGET-0002",
      operation: "discovery-run",
      payload: {
        ...discoveryPayload(envelope.grant.grantId),
        sourceKey: "greenhouse:budget-exhausted"
      }
    }, new Date(NOW_MS + 1_000));

    expect(blocked).toMatchObject({
      postings: [],
      dedupe: null,
      endpointObservation: { domain: "source-observations" },
      endpointLiveness: { domain: "liveness-assessments" }
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const consumptionEvents = (await store.readAll()).filter(
      (event) => event.eventType === "network-access-consumed"
    );
    expect(consumptionEvents).toHaveLength(1);
  });

  it("rejects an untrusted or tampered signed grant before persistence and transport", async () => {
    const attackerKeys = generateKeyPairSync("ed25519");
    const untrusted = createSignedNetworkAccessGrant(grant(2), {
      approvedBy: "operator:attacker",
      keyId: "KEY-DISCOVERY-ATTACKER-0001",
      privateKey: attackerKeys.privateKey
    });
    await expect(authority.execute({
      id: "REQ-NETWORK-GRANT-UNTRUSTED-0001",
      operation: "network-grant-register",
      payload: { envelope: untrusted, scopeUrl: null }
    }, NOW)).rejects.toThrow(/issuer-not-trusted/);

    const trusted = createSignedNetworkAccessGrant(grant(3), {
      approvedBy,
      keyId,
      privateKey: signingKeys.privateKey
    });
    const signature = Buffer.from(trusted.signature, "base64url");
    signature[0] = signature[0]! ^ 1;
    await expect(authority.execute({
      id: "REQ-NETWORK-GRANT-TAMPERED-0001",
      operation: "network-grant-register",
      payload: {
        envelope: { ...trusted, signature: signature.toString("base64url") },
        scopeUrl: null
      }
    }, NOW)).rejects.toThrow(/signature-invalid/);

    expect(await authority.execute({
      id: "REQ-NETWORK-GRANT-LIST-EMPTY",
      operation: "network-grant-list",
      payload: { cursor: null, limit: 50 }
    }, NOW)).toMatchObject({ items: [] });
    expect(transport).not.toHaveBeenCalled();
  });
});
