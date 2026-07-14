import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSubmissionProof, type TrustedCollector } from "../../src/submission-proof.js";
import { ApplicationTracker } from "../../src/storage/application-tracker.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { ProductRepositories } from "../../src/storage/product-repositories.js";
import { RuntimeRepository } from "../../src/storage/runtime-repository.js";
import { demoApprovalReference, demoPacket, demoTrustedApprovers, noHighStakesFlags } from "../fixtures.js";

const NOW = new Date("2026-07-12T05:00:00.000Z");
const collectorKey = generateKeyPairSync("ed25519");
const collector: TrustedCollector = {
  collectorId: "COL-TRACKER-ATS",
  keyId: "KEY-TRACKER-COLLECTOR-001",
  publicKeyPem: collectorKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
  allowedAdapters: ["local-fixture"],
  allowedSourceDomains: ["ats.example.test"],
  allowedKinds: ["confirmation-page"]
};

function context(seed: number) {
  return {
    operationId: `REQ-TRACKER-${seed.toString().padStart(8, "0")}`,
    now: new Date(NOW.getTime() + seed * 1_000)
  };
}

describe("event sourced application tracker", () => {
  let root: string;
  let store: EncryptedEventStore;
  let tracker: ApplicationTracker;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-application-tracker-"));
    store = await EncryptedEventStore.open(path.join(root, "vocation.db"), "application tracker passphrase");
    tracker = new ApplicationTracker(new ProductRepositories(store), demoTrustedApprovers(), [collector]);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists the prepared approved submitted and collector confirmed lifecycle", async () => {
    const packet = demoPacket();
    const prepared = await tracker.create({
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId: "local-fixture",
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: noHighStakesFlags()
    }, context(1));
    const approvedAt = new Date(NOW.getTime() + 2_000);
    const approved = await tracker.approve(
      prepared.recordId,
      prepared.version,
      demoApprovalReference({ packet, now: approvedAt, actionIntentHash: prepared.value.actionIntentHash }),
      { ...context(2), now: approvedAt }
    );
    const submitted = await tracker.markSubmitted(approved.recordId, approved.version, context(3));
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
      capturedAt: context(4).now.toISOString(),
      sourceDomain: "ats.example.test",
      sourcePointer: "proof:tracker:confirmation",
      indicators: ["Application submitted successfully"],
      payloadHash: `sha256:${"d".repeat(64)}`
    }, collectorKey.privateKey);
    const confirmed = await tracker.confirm(submitted.recordId, submitted.version, proof, context(5));

    expect([prepared, approved, submitted, confirmed].map((record) => record.value.status)).toEqual([
      "prepared",
      "approved",
      "submitted_unconfirmed",
      "confirmed"
    ]);
    expect(confirmed.version).toBe(4);
    expect((await store.verifyIntegrity()).eventCount).toBe(4);
    const ledger = await new RuntimeRepository(store).readLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ result: "confirmed", opportunityId: packet.opportunityId });
    const confirmationEvent = (await store.readAll<{ audit?: { proof?: { proofId?: string }; proofEvaluation?: { status?: string } } }>()).at(-1);
    expect(confirmationEvent?.payload.audit).toMatchObject({
      proof: { proofId: proof.proofId },
      proofEvaluation: { status: "confirmed" }
    });
  });

  it("fails closed on stale transitions and untrusted confirmation proof", async () => {
    const packet = demoPacket();
    const prepared = await tracker.create({
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId: "local-fixture",
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: noHighStakesFlags()
    }, context(10));
    await expect(tracker.markSubmitted(prepared.recordId, prepared.version, context(11)))
      .rejects.toThrow("must be approved");
    await expect(tracker.block(prepared.recordId, 99, "operator stop", context(12)))
      .rejects.toThrow("version conflict");
    expect((await store.verifyIntegrity()).eventCount).toBe(1);
  });
});
