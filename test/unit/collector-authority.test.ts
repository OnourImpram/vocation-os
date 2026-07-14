import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import { createSubmissionProof, type TrustedCollector } from "../../src/submission-proof.js";
import { MemoryCredentialStore } from "../../src/security/credential-store.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { RuntimeRepository } from "../../src/storage/runtime-repository.js";
import { demoApprovalReference, demoPacket, demoTrustedApprovers, noHighStakesFlags } from "../fixtures.js";

const NOW = new Date("2026-07-12T07:00:00.000Z");

describe("daemon owned trusted collector confirmation", () => {
  let root: string;
  let store: EncryptedEventStore;
  let authority: RuntimeAuthority;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-collector-authority-"));
    store = await EncryptedEventStore.open(path.join(root, "vocation.db"), "collector authority passphrase");
    authority = new RuntimeAuthority(store, new MemoryCredentialStore(), root);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers a collector and atomically persists proof evaluation transition and ledger evidence", async () => {
    const packet = demoPacket();
    const approver = demoTrustedApprovers()[0]!;
    await authority.execute({
      id: "REQ-COLLECTOR-APPROVER-REGISTER-0001",
      operation: "approver-register",
      payload: approver
    }, NOW);

    const keyPair = generateKeyPairSync("ed25519");
    const collector: TrustedCollector = {
      collectorId: "COL-AUTHORITY-ATS",
      keyId: "KEY-AUTHORITY-COLLECTOR-001",
      publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedAdapters: ["local-fixture"],
      allowedSourceDomains: ["ats.example.test"],
      allowedKinds: ["confirmation-page"]
    };
    await authority.execute({
      id: "REQ-COLLECTOR-REGISTER-0001",
      operation: "collector-register",
      payload: collector
    }, new Date(NOW.getTime() + 1_000));
    await expect(authority.execute({
      id: "REQ-COLLECTOR-LIST-0001",
      operation: "collector-list",
      payload: {}
    })).resolves.toEqual([collector]);

    const prepared = await authority.execute({
      id: "REQ-COLLECTOR-TRACKER-CREATE-0001",
      operation: "tracker-create",
      payload: {
        input: {
          opportunityId: packet.opportunityId,
          packetHash: packet.packetHash,
          adapterId: "local-fixture",
          channel: "ats-form",
          reversibilityTag: "R3",
          highStakesFlags: noHighStakesFlags()
        }
      }
    }, new Date(NOW.getTime() + 2_000)) as { recordId: string; version: number; value: { actionIntentHash: string } };
    const approvedAt = new Date(NOW.getTime() + 3_000);
    const approved = await authority.execute({
      id: "REQ-COLLECTOR-TRACKER-APPROVE-0001",
      operation: "tracker-approve",
      payload: {
        attemptId: prepared.recordId,
        expectedVersion: prepared.version,
        approval: demoApprovalReference({
          packet,
          now: approvedAt,
          actionIntentHash: prepared.value.actionIntentHash
        })
      }
    }, approvedAt) as { recordId: string; version: number };
    const submittedAt = new Date(NOW.getTime() + 4_000);
    const submitted = await authority.execute({
      id: "REQ-COLLECTOR-TRACKER-SUBMIT-0001",
      operation: "tracker-submit",
      payload: { attemptId: approved.recordId, expectedVersion: approved.version }
    }, submittedAt) as {
      recordId: string;
      version: number;
      value: { attemptId: string; actionIntentHash: string; opportunityId: string; packetHash: string; adapterId: string };
    };
    const proof = createSubmissionProof({
      collectorId: collector.collectorId,
      collectorVersion: "1.0.0",
      keyId: collector.keyId,
      attemptId: submitted.value.attemptId,
      actionIntentHash: submitted.value.actionIntentHash,
      opportunityId: submitted.value.opportunityId,
      packetHash: submitted.value.packetHash,
      adapterId: submitted.value.adapterId,
      kind: "confirmation-page",
      capturedAt: new Date(NOW.getTime() + 5_000).toISOString(),
      sourceDomain: "ats.example.test",
      sourcePointer: "proof:authority:confirmation",
      indicators: ["Application submitted successfully"],
      payloadHash: `sha256:${"9".repeat(64)}`
    }, keyPair.privateKey);
    const confirmed = await authority.execute({
      id: "REQ-COLLECTOR-TRACKER-CONFIRM-0001",
      operation: "tracker-confirm",
      payload: { attemptId: submitted.recordId, expectedVersion: submitted.version, proof }
    }, new Date(NOW.getTime() + 6_000)) as { value: { status: string; proofId: string } };

    expect(confirmed.value).toMatchObject({ status: "confirmed", proofId: proof.proofId });
    expect(await new RuntimeRepository(store).readLedger()).toEqual([
      expect.objectContaining({ result: "confirmed", opportunityId: packet.opportunityId })
    ]);
    const finalEvent = (await store.readAll<{ audit?: { proof?: { proofId?: string }; proofEvaluation?: { status?: string } } }>()).at(-1);
    expect(finalEvent?.payload.audit).toMatchObject({
      proof: { proofId: proof.proofId },
      proofEvaluation: { status: "confirmed" }
    });
  });
});
