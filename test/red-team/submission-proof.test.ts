import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../../src/schema.js";
import {
  createSubmissionProof,
  evaluateSubmissionProof,
  type SubmissionObservationDraft,
  type TrustedCollector
} from "../../src/submission-proof.js";

const PACKET_HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYLOAD_HASH = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACTION_INTENT_HASH = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const ATTEMPT_ID = "ATT-2026-00000000-0000-4000-8000-000000000001";
const trustedKeyPair = generateKeyPairSync("ed25519");
const rogueKeyPair = generateKeyPairSync("ed25519");

const trustedCollector: TrustedCollector = {
  collectorId: "COL-TEST-ATS",
  keyId: "KEY-TEST-001",
  publicKeyPem: trustedKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  allowedAdapters: ["local-fixture"],
  allowedSourceDomains: ["ats.example.test"],
  allowedKinds: ["confirmation-page", "ats-dashboard", "sent-items", "receipt-email"]
};

function draft(overrides: Partial<SubmissionObservationDraft> = {}): SubmissionObservationDraft {
  return {
    collectorId: trustedCollector.collectorId,
    collectorVersion: "1.0.0",
    keyId: trustedCollector.keyId,
    attemptId: ATTEMPT_ID,
    actionIntentHash: ACTION_INTENT_HASH,
    opportunityId: "OPP-DEMO-001",
    packetHash: PACKET_HASH,
    adapterId: "local-fixture",
    kind: "confirmation-page",
    capturedAt: "2026-07-11T00:00:00.000Z",
    sourceDomain: "ats.example.test",
    sourcePointer: "proof:ats:confirmation",
    indicators: ["Thank you for applying. Your application has been received."],
    payloadHash: PAYLOAD_HASH,
    ...overrides
  };
}

const expectation = {
  attemptId: ATTEMPT_ID,
  actionIntentHash: ACTION_INTENT_HASH,
  opportunityId: "OPP-DEMO-001",
  packetHash: PACKET_HASH,
  adapterId: "local-fixture",
  submittedAt: "2026-07-11T00:00:00.000Z",
  evaluatedAt: "2026-07-11T00:03:00.000Z"
};

describe("trusted submission proof", () => {
  it("confirms a signed collector observation", () => {
    const proof = createSubmissionProof(draft(), trustedKeyPair.privateKey);
    expect(evaluateSubmissionProof(proof, [trustedCollector], expectation)).toMatchObject({
      status: "confirmed",
      ledgerEligible: true
    });
  });

  it("rejects an unknown collector", () => {
    const proof = createSubmissionProof(draft(), trustedKeyPair.privateKey);
    expect(evaluateSubmissionProof(proof, [], expectation).reasons).toContain("collector is not trusted");
  });

  it("rejects a forged signature using the trusted collector id", () => {
    const proof = createSubmissionProof(draft(), rogueKeyPair.privateKey);
    expect(evaluateSubmissionProof(proof, [trustedCollector], expectation).reasons).toContain("collector signature is invalid");
  });

  it("rejects observation tampering after signature", () => {
    const proof = createSubmissionProof(draft(), trustedKeyPair.privateKey);
    const tampered = { ...proof, indicators: [...proof.indicators, "forged after signing"] };
    expect(evaluateSubmissionProof(tampered, [trustedCollector], expectation).reasons).toContain(
      "receipt hash does not match the collector observation"
    );
  });

  it("rejects a proof bound to another packet", () => {
    const proof = createSubmissionProof(draft(), trustedKeyPair.privateKey);
    const result = evaluateSubmissionProof(proof, [trustedCollector], {
      ...expectation,
      packetHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    });
    expect(result.reasons).toContain("proof binding does not match the application attempt");
  });

  it("rejects replay against another application attempt", () => {
    const proof = createSubmissionProof(draft(), trustedKeyPair.privateKey);
    const result = evaluateSubmissionProof(proof, [trustedCollector], {
      ...expectation,
      attemptId: "ATT-2026-00000000-0000-4000-8000-000000000002"
    });
    expect(result.reasons).toContain("proof binding does not match the application attempt");
  });

  it("rejects a proof captured before the submission attempt", () => {
    const proof = createSubmissionProof(
      draft({ capturedAt: "2026-07-10T23:00:00.000Z" }),
      trustedKeyPair.privateKey
    );
    expect(evaluateSubmissionProof(proof, [trustedCollector], expectation).reasons).toContain(
      "proof capture time is outside the application attempt window"
    );
  });

  it("rejects negative completion signals even when signed", () => {
    const proof = createSubmissionProof(
      draft({ indicators: ["Copy this verification code and complete your application."] }),
      trustedKeyPair.privateKey
    );
    expect(evaluateSubmissionProof(proof, [trustedCollector], expectation).status).toBe("rejected");
  });

  it("requires an attachment for trusted Sent Items evidence", () => {
    const proof = createSubmissionProof(
      draft({
        kind: "sent-items",
        sourcePointer: "proof:outlook:sent-item",
        recipientDomain: "example.test",
        sentAt: "2026-07-11T00:00:00.000Z",
        attachmentCount: 0,
        indicators: []
      }),
      trustedKeyPair.privateKey
    );
    expect(evaluateSubmissionProof(proof, [trustedCollector], expectation).status).toBe("insufficient");
  });

  it("does not accept caller asserted official route fields", () => {
    const proof = createSubmissionProof(draft(), trustedKeyPair.privateKey);
    expect(validateAgainstSchema("submission-proof", { ...proof, officialRoute: true }).valid).toBe(false);
  });

  it("rejects sensitive URLs and query tokens in proof reference ids", () => {
    expect(() =>
      createSubmissionProof(
        draft({ referenceId: "https://ats.example.test/application?id=secret-token" }),
        trustedKeyPair.privateKey
      )
    ).toThrow("bounded opaque identifiers");
  });
});
