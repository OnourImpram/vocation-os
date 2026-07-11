import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  approveApplicationAttempt,
  confirmApplicationAttempt,
  confirmationLedgerEntry,
  createApplicationAttempt,
  markSubmissionAttempted
} from "../../src/application-lifecycle.js";
import { createSubmissionProof, type TrustedCollector } from "../../src/submission-proof.js";
import { demoApprovalReference, demoPacket, demoTrustedApprovers, noHighStakesFlags } from "../fixtures.js";
import type { ApplicationAttempt } from "../../src/application-lifecycle.js";

const keyPair = generateKeyPairSync("ed25519");
const collector: TrustedCollector = {
  collectorId: "COL-LIFECYCLE-ATS",
  keyId: "KEY-LIFECYCLE-001",
  publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  allowedAdapters: ["local-fixture"],
  allowedSourceDomains: ["ats.example.test"],
  allowedKinds: ["confirmation-page"]
};

const packet = demoPacket();
const approvalNow = new Date("2026-07-11T00:01:00.000Z");

function proof(attempt: ApplicationAttempt, packetHash = packet.packetHash) {
  return createSubmissionProof(
    {
      collectorId: collector.collectorId,
      collectorVersion: "1.0.0",
      keyId: collector.keyId,
      attemptId: attempt.attemptId,
      actionIntentHash: attempt.actionIntentHash,
      opportunityId: packet.opportunityId,
      packetHash,
      adapterId: "local-fixture",
      kind: "confirmation-page",
      capturedAt: "2026-07-11T00:02:00.000Z",
      sourceDomain: "ats.example.test",
      sourcePointer: "proof:ats:confirmation",
      indicators: ["Application submitted successfully"],
      payloadHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    },
    keyPair.privateKey
  );
}

function submittedAttempt() {
  const prepared = createApplicationAttempt({
    opportunityId: packet.opportunityId,
    packetHash: packet.packetHash,
    adapterId: "local-fixture",
    channel: "ats-form",
    reversibilityTag: "R3",
    highStakesFlags: noHighStakesFlags(),
    now: new Date("2026-07-11T00:00:00.000Z")
  });
  const approved = approveApplicationAttempt(
    prepared,
    demoApprovalReference({ packet, now: approvalNow }),
    demoTrustedApprovers(),
    approvalNow
  );
  return markSubmissionAttempted(approved, new Date("2026-07-11T00:01:30.000Z"));
}

describe("application lifecycle", () => {
  it("requires a trusted proof before confirmation", () => {
    const attempt = submittedAttempt();
    const result = confirmApplicationAttempt(
      attempt,
      proof(attempt),
      [collector],
      undefined,
      new Date("2026-07-11T00:03:00.000Z")
    );
    expect(result.attempt.status).toBe("confirmed");
    expect(result.proofEvaluation.ledgerEligible).toBe(true);
  });

  it("rejects proof signed by an untrusted collector registry", () => {
    const attempt = submittedAttempt();
    expect(() => confirmApplicationAttempt(attempt, proof(attempt), [])).toThrow("collector is not trusted");
  });

  it("rejects proof bound to another packet", () => {
    const otherHash = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const attempt = submittedAttempt();
    expect(() => confirmApplicationAttempt(attempt, proof(attempt, otherHash), [collector])).toThrow("does not match");
  });

  it("cannot submit when the high stakes gate has not passed", () => {
    const prepared = createApplicationAttempt({
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId: "local-fixture",
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: { ...noHighStakesFlags(), licensingSensitive: true },
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    const approved = approveApplicationAttempt(prepared, demoApprovalReference({ packet, now: approvalNow }), demoTrustedApprovers(), approvalNow);
    expect(() => markSubmissionAttempted(approved)).toThrow("High stakes gate must pass");
  });

  it("creates a ledger entry bound to proof and collector", () => {
    const attempt = submittedAttempt();
    const submissionProof = proof(attempt);
    const confirmed = confirmApplicationAttempt(attempt, submissionProof, [collector]).attempt;
    const entry = confirmationLedgerEntry(confirmed, submissionProof, new Date("2026-07-11T00:04:00.000Z"));
    expect(entry.result).toBe("confirmed");
    expect(entry.confirmationEvidencePointer).toContain(collector.collectorId);
    expect(entry.confirmationEvidencePointer).toContain(submissionProof.receiptHash);
  });

  it("rejects a mutated receipt at the confirmation ledger boundary", () => {
    const attempt = submittedAttempt();
    const submissionProof = proof(attempt);
    const confirmed = confirmApplicationAttempt(attempt, submissionProof, [collector]).attempt;
    const mutated = {
      ...submissionProof,
      receiptHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    };
    expect(() => confirmationLedgerEntry(confirmed, mutated)).toThrow("collector bound confirmed attempt");
  });

  it("rejects an approval scoped to a different packet", () => {
    const prepared = createApplicationAttempt({
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId: "local-fixture",
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: noHighStakesFlags(),
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    const otherPacket = demoPacket("verified", { opportunityId: "OPP-OTHER-001" });
    expect(() => approveApplicationAttempt(prepared, demoApprovalReference({ packet: otherPacket, now: approvalNow }), demoTrustedApprovers(), approvalNow)).toThrow(
      "approval-scope-mismatch"
    );
  });

  it("rejects a caller-minted approval outside the trusted approver registry", () => {
    const prepared = createApplicationAttempt({
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId: "local-fixture",
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: noHighStakesFlags(),
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    expect(() => approveApplicationAttempt(prepared, demoApprovalReference({ packet, now: approvalNow }), [], approvalNow)).toThrow(
      "approver-not-trusted"
    );
  });

  it("rejects approval scope tampering after the human signature", () => {
    const prepared = createApplicationAttempt({
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId: "local-fixture",
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: noHighStakesFlags(),
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    const approval = demoApprovalReference({ packet, now: approvalNow });
    const tampered = { ...approval, allowedFields: [...approval.allowedFields, "private-field"] };
    expect(() => approveApplicationAttempt(prepared, tampered, demoTrustedApprovers(), approvalNow)).toThrow(
      "approval-signature-invalid"
    );
  });
});
