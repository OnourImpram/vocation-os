import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApprovalReference, type TrustedApprover } from "../../src/approval.js";
import { defaultAutoApplyConfig } from "../../src/auto-apply.js";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import { computeActionIntentHash, sha256 } from "../../src/hash.js";
import { MemoryCredentialStore } from "../../src/security/credential-store.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { RuntimeRepository } from "../../src/storage/runtime-repository.js";
import type { ApplicationPacket, AutoApplyDecision } from "../../src/types.js";
import {
  demoGraph,
  demoPacket,
  noHighStakesFlags,
  noRiskSignals
} from "../fixtures.js";

const STORE_PASSPHRASE = "runtime policy authority test passphrase";
const NOW = new Date("2026-07-11T12:00:00.000Z");

interface ApproverMaterial {
  approver: TrustedApprover;
  privateKey: KeyObject;
}

function createApprover(keyId = "KEY-RUNTIME-POLICY-001"): ApproverMaterial {
  const keyPair = generateKeyPairSync("ed25519");
  return {
    approver: {
      approvedBy: "runtime-policy-operator",
      keyId,
      publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
    },
    privateKey: keyPair.privateKey
  };
}

function createAutoApplyApproval(
  packet: ApplicationPacket,
  material: ApproverMaterial,
  adapterId = "local-fixture",
  approvalId = "APR-RUNTIME-POLICY-001"
) {
  return createApprovalReference({
    approvalId,
    operation: "auto-apply",
    approvedBy: material.approver.approvedBy,
    keyId: material.approver.keyId,
    approvedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    approvalTextHash: sha256("Approve the bound synthetic application packet"),
    opportunityId: packet.opportunityId,
    packetHash: packet.packetHash,
    adapterId,
    actionIntentHash: computeActionIntentHash({
      operation: "auto-apply",
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId,
      reversibilityTag: "R3"
    }),
    allowedFields: ["application-packet"]
  }, material.privateKey);
}

describe("runtime policy authority", () => {
  let runtimeRoot: string;
  let databasePath: string;
  let store: EncryptedEventStore | undefined;
  let credentials: MemoryCredentialStore;

  beforeEach(() => {
    runtimeRoot = mkdtempSync(path.join(tmpdir(), "vocation-runtime-policy-"));
    databasePath = path.join(runtimeRoot, "vocation.db");
    credentials = new MemoryCredentialStore();
  });

  afterEach(async () => {
    if (store) {
      await store.close();
      store = undefined;
    }
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  async function openAuthority(): Promise<RuntimeAuthority> {
    store = await EncryptedEventStore.open(databasePath, STORE_PASSPHRASE);
    return new RuntimeAuthority(store, credentials, runtimeRoot);
  }

  async function reopenAuthority(): Promise<RuntimeAuthority> {
    await store?.close();
    store = undefined;
    return openAuthority();
  }

  async function enableAutoMode(authority: RuntimeAuthority, requestId: string): Promise<void> {
    await authority.execute({
      id: requestId,
      operation: "auto-apply-enable",
      payload: { mode: "auto" }
    }, NOW);
  }

  async function registerApprover(
    authority: RuntimeAuthority,
    material: ApproverMaterial,
    requestId: string
  ): Promise<unknown> {
    return authority.execute({
      id: requestId,
      operation: "approver-register",
      payload: material.approver
    }, NOW);
  }

  it("persists idempotent approver registration and revocation across reopen", async () => {
    let authority = await openAuthority();
    const material = createApprover();
    const registerRequest = {
      id: "REQ-APPROVER-REGISTER-0001",
      operation: "approver-register" as const,
      payload: material.approver
    };

    const registered = await authority.execute(registerRequest, NOW);
    const registrationReplay = await authority.execute(
      registerRequest,
      new Date(NOW.getTime() + 60_000)
    );

    expect(registrationReplay).toStrictEqual(registered);
    expect(await authority.execute({
      id: "REQ-APPROVER-LIST-0001",
      operation: "approver-list",
      payload: {}
    })).toStrictEqual([material.approver]);
    expect((await store!.readAll()).filter(
      (event) => event.eventType === "approver-register-completed"
    )).toHaveLength(1);

    authority = await reopenAuthority();
    expect(await authority.execute({
      id: "REQ-APPROVER-LIST-0002",
      operation: "approver-list",
      payload: {}
    })).toStrictEqual([material.approver]);

    const revokeRequest = {
      id: "REQ-APPROVER-REVOKE-0001",
      operation: "approver-revoke" as const,
      payload: { keyId: material.approver.keyId }
    };
    const revoked = await authority.execute(revokeRequest, NOW);
    const revocationReplay = await authority.execute(
      revokeRequest,
      new Date(NOW.getTime() + 60_000)
    );

    expect(revocationReplay).toStrictEqual(revoked);
    expect(await authority.execute({
      id: "REQ-APPROVER-LIST-0003",
      operation: "approver-list",
      payload: {}
    })).toStrictEqual([]);
    expect((await store!.readAll()).filter(
      (event) => event.eventType === "approver-revoke-completed"
    )).toHaveLength(1);

    authority = await reopenAuthority();
    expect(await authority.execute({
      id: "REQ-APPROVER-LIST-0004",
      operation: "approver-list",
      payload: {}
    })).toStrictEqual([]);
    expect((await store?.chainHead())?.eventCount).toBe(2);
  });

  it("does not let caller supplied config enable canonical disabled automation", async () => {
    const authority = await openAuthority();
    const packet = demoPacket();
    const material = createApprover();
    const callerConfig = {
      ...defaultAutoApplyConfig(),
      enabled: true,
      mode: "auto" as const
    };

    const decision = await authority.execute({
      id: "REQ-CALLER-CONFIG-BYPASS-0001",
      operation: "auto-apply-evaluate",
      payload: {
        packet,
        claimGraph: demoGraph(),
        reversibilityTag: "R3",
        adapterId: "local-fixture",
        approvalReference: createAutoApplyApproval(packet, material),
        riskSignals: noRiskSignals(),
        highStakesFlags: noHighStakesFlags(),
        config: callerConfig,
        trustedApprovers: [material.approver]
      }
    }, NOW) as AutoApplyDecision;

    expect(decision).toMatchObject({
      allowed: false,
      blockedBy: "auto-apply-disabled"
    });
  });

  it("rejects a malformed application packet before writing an authoritative ledger event", async () => {
    const authority = await openAuthority();
    const malformedPacket = { ...demoPacket() } as Record<string, unknown>;
    delete malformedPacket["opportunityId"];

    await expect(authority.execute({
      id: "REQ-MALFORMED-PACKET-0001",
      operation: "auto-apply-evaluate",
      payload: {
        packet: malformedPacket,
        claimGraph: demoGraph(),
        reversibilityTag: "R3",
        adapterId: "local-fixture",
        riskSignals: noRiskSignals(),
        highStakesFlags: noHighStakesFlags()
      }
    }, NOW)).rejects.toThrow("application-packet validation failed");

    const repository = new RuntimeRepository(store!);
    expect(await repository.readLedger()).toStrictEqual([]);
    expect((await store!.readAll()).filter(
      (event) => event.aggregateType === "action-ledger"
    )).toStrictEqual([]);
    expect((await store!.chainHead()).eventCount).toBe(0);
  });

  it("does not trust a caller supplied approver registry", async () => {
    const authority = await openAuthority();
    await enableAutoMode(authority, "REQ-ENABLE-APPROVER-TEST-0001");
    const packet = demoPacket();
    const unregistered = createApprover("KEY-CALLER-INJECTED-001");

    const decision = await authority.execute({
      id: "REQ-CALLER-APPROVER-BYPASS-0001",
      operation: "auto-apply-evaluate",
      payload: {
        packet,
        claimGraph: demoGraph(),
        reversibilityTag: "R3",
        adapterId: "local-fixture",
        approvalReference: createAutoApplyApproval(
          packet,
          unregistered,
          "local-fixture",
          "APR-CALLER-INJECTED-001"
        ),
        riskSignals: noRiskSignals(),
        highStakesFlags: noHighStakesFlags(),
        trustedApprovers: [unregistered.approver]
      }
    }, NOW) as AutoApplyDecision;

    expect(decision).toMatchObject({
      allowed: false,
      blockedBy: "approver-not-trusted"
    });
  });

  it("uses canonical config approvers ledger and document root for an idempotent allowed decision", async () => {
    const authority = await openAuthority();
    await enableAutoMode(authority, "REQ-ENABLE-ALLOWED-TEST-0001");
    const material = createApprover();
    await registerApprover(authority, material, "REQ-REGISTER-ALLOWED-TEST-0001");
    const packet = demoPacket();
    const callerLedgerPath = path.join(runtimeRoot, "caller-controlled-ledger.jsonl");
    const request = {
      id: "REQ-ALLOWED-POLICY-0001",
      operation: "auto-apply-evaluate" as const,
      payload: {
        packet,
        claimGraph: demoGraph(),
        reversibilityTag: "R3",
        adapterId: "local-fixture",
        approvalReference: createAutoApplyApproval(packet, material),
        riskSignals: noRiskSignals(),
        highStakesFlags: noHighStakesFlags(),
        config: {
          ...defaultAutoApplyConfig(),
          enabled: false,
          mode: "manual",
          killSwitch: {
            available: true,
            engaged: true,
            engagedBy: "caller",
            engagedAt: NOW.toISOString(),
            reason: "caller supplied state"
          },
          adapterAllowlist: []
        },
        trustedApprovers: [],
        ledgerPath: callerLedgerPath,
        documentRoot: runtimeRoot
      }
    };

    const decision = await authority.execute(request, NOW) as AutoApplyDecision;
    const replay = await authority.execute(
      request,
      new Date(NOW.getTime() + 60_000)
    ) as AutoApplyDecision;

    expect(decision).toMatchObject({
      allowed: true,
      reasons: ["all gates passed"],
      confirmationEvidenceRequired: true
    });
    expect(replay).toStrictEqual(decision);
    expect(existsSync(callerLedgerPath)).toBe(false);

    const repository = new RuntimeRepository(store!);
    expect(await repository.readLedger()).toStrictEqual([
      expect.objectContaining({
        actionId: decision.ledgerActionId,
        opportunityId: packet.opportunityId,
        result: "decision_allowed",
        approvalReceived: true,
        evidenceGatePassed: true,
        highStakesGatePassed: true
      })
    ]);
    expect((await store!.readAll()).filter(
      (event) => event.eventType === "auto-apply-decision-recorded"
    )).toHaveLength(1);
  });

  it("blocks an uncompiled adapter despite caller supplied allowlist authority", async () => {
    const authority = await openAuthority();
    await enableAutoMode(authority, "REQ-ENABLE-ADAPTER-TEST-0001");
    const material = createApprover();
    await registerApprover(authority, material, "REQ-REGISTER-ADAPTER-TEST-0001");
    const packet = demoPacket();
    const adapterId = "caller-injected-adapter";

    const decision = await authority.execute({
      id: "REQ-UNCOMPILED-ADAPTER-0001",
      operation: "auto-apply-evaluate",
      payload: {
        packet,
        claimGraph: demoGraph(),
        reversibilityTag: "R3",
        adapterId,
        approvalReference: createAutoApplyApproval(
          packet,
          material,
          adapterId,
          "APR-UNCOMPILED-ADAPTER-001"
        ),
        riskSignals: noRiskSignals(),
        highStakesFlags: noHighStakesFlags(),
        config: {
          ...defaultAutoApplyConfig(),
          enabled: true,
          mode: "auto",
          adapterAllowlist: [adapterId]
        }
      }
    }, NOW) as AutoApplyDecision;

    expect(decision).toMatchObject({
      allowed: false,
      blockedBy: "adapter-authority-denied"
    });
    expect(decision.reasons.join(" ")).toContain("not executable by this build");
  });

  it("blocks local private profiles from the synthetic local fixture adapter", async () => {
    const authority = await openAuthority();
    await enableAutoMode(authority, "REQ-ENABLE-PRIVATE-TEST-0001");
    const material = createApprover();
    await registerApprover(authority, material, "REQ-REGISTER-PRIVATE-TEST-0001");
    const packet = demoPacket();

    const decision = await authority.execute({
      id: "REQ-LOCAL-PRIVATE-BLOCK-0001",
      operation: "auto-apply-evaluate",
      payload: {
        packet,
        claimGraph: demoGraph({
          profileId: "LOCAL-PRIVATE-001",
          profileScope: "local-private"
        }),
        reversibilityTag: "R3",
        adapterId: "local-fixture",
        approvalReference: createAutoApplyApproval(
          packet,
          material,
          "local-fixture",
          "APR-LOCAL-PRIVATE-001"
        ),
        riskSignals: noRiskSignals(),
        highStakesFlags: noHighStakesFlags()
      }
    }, NOW) as AutoApplyDecision;

    expect(decision).toMatchObject({
      allowed: false,
      blockedBy: "adapter-authority-denied"
    });
    expect(decision.reasons.join(" ")).toContain("restricted to synthetic fixtures");
  });
});
