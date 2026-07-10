import { describe, expect, it } from "vitest";
import {
  approveApplicationAttempt,
  confirmApplicationAttempt,
  confirmationLedgerEntry,
  createApplicationAttempt,
  markSubmissionAttempted
} from "../../src/application-lifecycle.js";
import { buildSubmissionProof } from "../../src/submission-proof.js";
import { demoApprovalReference } from "../fixtures.js";

const PACKET_HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function proof(opportunityId = "OPP-DEMO-001") {
  return buildSubmissionProof({
    opportunityId,
    kind: "confirmation-page",
    capturedAt: "2026-07-10T00:02:00.000Z",
    sourcePointer: "redacted:confirmation:demo",
    officialRoute: true,
    indicators: ["Application submitted successfully"]
  });
}

function submittedAttempt() {
  const prepared = createApplicationAttempt({
    opportunityId: "OPP-DEMO-001",
    packetHash: PACKET_HASH,
    channel: "ats-form",
    now: new Date("2026-07-10T00:00:00.000Z")
  });
  const approved = approveApplicationAttempt(prepared, demoApprovalReference(), new Date("2026-07-10T00:01:00.000Z"));
  return markSubmissionAttempted(approved, new Date("2026-07-10T00:01:30.000Z"));
}

describe("application lifecycle", () => {
  it("moves through prepared, approved, submitted unconfirmed, and confirmed", () => {
    const submitted = submittedAttempt();
    expect(submitted.status).toBe("submitted_unconfirmed");
    const result = confirmApplicationAttempt(submitted, proof(), undefined, new Date("2026-07-10T00:03:00.000Z"));
    expect(result.attempt.status).toBe("confirmed");
    expect(result.attempt.proofId).toBe(proof().proofId);
  });

  it("cannot confirm before a submission attempt exists", () => {
    const prepared = createApplicationAttempt({
      opportunityId: "OPP-DEMO-001",
      packetHash: PACKET_HASH,
      channel: "ats-form",
      now: new Date("2026-07-10T00:00:00.000Z")
    });
    expect(() => confirmApplicationAttempt(prepared, proof())).toThrow("must be submitted_unconfirmed");
  });

  it("rejects proof for a different opportunity", () => {
    expect(() => confirmApplicationAttempt(submittedAttempt(), proof("OPP-OTHER-001"))).toThrow("does not match");
  });

  it("rejects insufficient proof", () => {
    const insufficient = buildSubmissionProof({
      opportunityId: "OPP-DEMO-001",
      kind: "confirmation-page",
      capturedAt: "2026-07-10T00:02:00.000Z",
      sourcePointer: "redacted:confirmation:empty",
      officialRoute: true,
      indicators: ["Please continue"]
    });
    expect(() => confirmApplicationAttempt(submittedAttempt(), insufficient)).toThrow("Submission proof is insufficient");
  });

  it("creates a proof bound confirmation ledger entry", () => {
    const submissionProof = proof();
    const confirmed = confirmApplicationAttempt(submittedAttempt(), submissionProof, undefined, new Date("2026-07-10T00:03:00.000Z")).attempt;
    const entry = confirmationLedgerEntry(confirmed, submissionProof, new Date("2026-07-10T00:04:00.000Z"));
    expect(entry).toMatchObject({
      opportunityId: "OPP-DEMO-001",
      result: "confirmed",
      approvalReceived: true
    });
    expect(entry.confirmationEvidencePointer).toContain(submissionProof.evidenceHash);
  });

  it("rejects malformed approval evidence before changing state", () => {
    const prepared = createApplicationAttempt({
      opportunityId: "OPP-DEMO-001",
      packetHash: PACKET_HASH,
      channel: "ats-form",
      now: new Date("2026-07-10T00:00:00.000Z")
    });
    expect(() => approveApplicationAttempt(prepared, { ...demoApprovalReference(), approvalId: "not-an-approval" })).toThrow(
      "APR- identifier format"
    );
    expect(() => approveApplicationAttempt(prepared, { ...demoApprovalReference(), approvalTextHash: "invalid" })).toThrow(
      "sha256 digest"
    );
  });
});
