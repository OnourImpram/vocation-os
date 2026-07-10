import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../../src/schema.js";
import {
  buildSubmissionProof,
  evaluateSubmissionProof,
  type SubmissionProof
} from "../../src/submission-proof.js";

function confirmation(overrides: Partial<Parameters<typeof buildSubmissionProof>[0]> = {}): SubmissionProof {
  return buildSubmissionProof({
    opportunityId: "OPP-DEMO-001",
    kind: "confirmation-page",
    capturedAt: "2026-07-10T00:00:00.000Z",
    sourcePointer: "redacted:confirmation:demo",
    officialRoute: true,
    indicators: ["Thank you for applying. Your application has been received."],
    ...overrides
  });
}

describe("submission proof red team", () => {
  it("confirms a positive official confirmation page", () => {
    expect(evaluateSubmissionProof(confirmation()).status).toBe("confirmed");
  });

  it("rejects a security code email as completion evidence", () => {
    const proof = buildSubmissionProof({
      opportunityId: "OPP-DEMO-001",
      kind: "receipt-email",
      capturedAt: "2026-07-10T00:00:00.000Z",
      sourcePointer: "redacted:mail:security-code",
      officialRoute: true,
      senderDomain: "greenhouse.io",
      indicators: ["Copy and paste this security code, then resubmit your application."]
    });
    expect(evaluateSubmissionProof(proof)).toMatchObject({ status: "rejected", ledgerEligible: false });
  });

  it("requires an attachment for official email proof by default", () => {
    const proof = buildSubmissionProof({
      opportunityId: "OPP-DEMO-001",
      kind: "sent-items",
      capturedAt: "2026-07-10T00:00:00.000Z",
      sentAt: "2026-07-10T00:00:00.000Z",
      sourcePointer: "redacted:outlook:sent-item",
      officialRoute: true,
      recipientDomain: "example.test",
      attachmentCount: 0
    });
    expect(evaluateSubmissionProof(proof)).toMatchObject({ status: "insufficient", ledgerEligible: false });
  });

  it("confirms Sent Items evidence with an attachment", () => {
    const proof = buildSubmissionProof({
      opportunityId: "OPP-DEMO-001",
      kind: "sent-items",
      capturedAt: "2026-07-10T00:00:00.000Z",
      sentAt: "2026-07-10T00:00:00.000Z",
      sourcePointer: "redacted:outlook:sent-item",
      officialRoute: true,
      recipientDomain: "example.test",
      attachmentCount: 1
    });
    expect(evaluateSubmissionProof(proof)).toMatchObject({ status: "confirmed", ledgerEligible: true });
  });

  it("rejects proof tampering after construction", () => {
    const proof = confirmation();
    const tampered = { ...proof, indicators: ["Application submitted", "forged after hashing"] };
    expect(evaluateSubmissionProof(tampered).status).toBe("rejected");
  });

  it("rejects unofficial routes", () => {
    expect(evaluateSubmissionProof(confirmation({ officialRoute: false })).status).toBe("rejected");
  });

  it("rejects raw body fields at the schema boundary", () => {
    expect(validateAgainstSchema("submission-proof", { ...confirmation(), rawBody: "private message body" }).valid).toBe(false);
  });

  it("rejects oversized indicators to prevent raw mailbox storage", () => {
    expect(() => confirmation({ indicators: ["x".repeat(201)] })).toThrow("must not exceed 200 characters");
  });

  it("rejects raw URLs and query data in proof source pointers", () => {
    expect(() => confirmation({ sourcePointer: "https://ats.example.test/confirmation?token=secret" })).toThrow(
      "must use a redacted:, local:, or proof: reference"
    );
    expect(() => confirmation({ sourcePointer: "redacted:https://ats.example.test/confirmation" })).toThrow(
      "must use a redacted:, local:, or proof: reference"
    );
  });

  it("rejects oversized proof source pointers", () => {
    expect(() => confirmation({ sourcePointer: `redacted:${"x".repeat(201)}` })).toThrow("must not exceed 200 characters");
  });
});
