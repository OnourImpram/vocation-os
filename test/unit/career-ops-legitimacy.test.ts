import { describe, expect, it } from "vitest";
import { assessLegitimacy } from "../../src/career-ops/legitimacy.js";
import type { OpportunityVerificationBundle } from "../../src/career-ops/verification.js";

const VERIFIED: OpportunityVerificationBundle = {
  opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
  status: "verified",
  primaryObservationId: "OBS-AAAAAAAAAAAAAAAAAAAA",
  independentObservationId: "OBS-BBBBBBBBBBBBBBBBBBBB",
  preActionObservationId: "OBS-CCCCCCCCCCCCCCCCCCCC",
  reasons: [],
  evaluatedAt: "2026-08-28T08:06:00.000Z",
  expiresAt: "2026-08-28T09:06:00.000Z",
  bundleHash: `sha256:${"a".repeat(64)}`
};

const SAFE_OBSERVATIONS = {
  paymentRequired: false,
  identityDocumentRequested: false,
  suspiciousContactDomain: false,
  agencyEmployerUnknown: false,
  repostCount90Days: 0,
  employerIdentityVerified: true,
  postingDateAvailable: true,
  extractionConfidence: "high" as const
};

describe("career operations legitimacy assessment", () => {
  it("returns green when verification is current and no warning signals exist", () => {
    const result = assessLegitimacy({
      opportunityId: VERIFIED.opportunityId,
      verification: VERIFIED,
      observations: SAFE_OBSERVATIONS,
      assessedAt: "2026-08-28T08:07:00.000Z"
    });

    expect(result.tier).toBe("green");
    expect(result.signals).toEqual([]);
    expect(result.assessmentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("returns red when payment is required before application", () => {
    const result = assessLegitimacy({
      opportunityId: VERIFIED.opportunityId,
      verification: VERIFIED,
      observations: { ...SAFE_OBSERVATIONS, paymentRequired: true },
      assessedAt: "2026-08-28T08:07:00.000Z"
    });

    expect(result.tier).toBe("red");
    expect(result.signals.map((signal) => signal.code)).toContain("payment-required");
  });

  it("returns red when the employer identity is not verified", () => {
    const result = assessLegitimacy({
      opportunityId: VERIFIED.opportunityId,
      verification: VERIFIED,
      observations: { ...SAFE_OBSERVATIONS, employerIdentityVerified: false },
      assessedAt: "2026-08-28T08:07:00.000Z"
    });

    expect(result.tier).toBe("red");
    expect(result.signals.map((signal) => signal.code)).toContain("employer-identity-unverified");
  });

  it("returns yellow for repeated reposting without a blocking signal", () => {
    const result = assessLegitimacy({
      opportunityId: VERIFIED.opportunityId,
      verification: VERIFIED,
      observations: { ...SAFE_OBSERVATIONS, repostCount90Days: 4 },
      assessedAt: "2026-08-28T08:07:00.000Z"
    });

    expect(result.tier).toBe("yellow");
    expect(result.signals.map((signal) => signal.code)).toContain("repeated-reposting");
  });

  it("returns yellow when the end employer is unknown in an agency route", () => {
    const result = assessLegitimacy({
      opportunityId: VERIFIED.opportunityId,
      verification: VERIFIED,
      observations: { ...SAFE_OBSERVATIONS, agencyEmployerUnknown: true },
      assessedAt: "2026-08-28T08:07:00.000Z"
    });

    expect(result.tier).toBe("yellow");
    expect(result.signals.map((signal) => signal.code)).toContain("agency-employer-unknown");
  });

  it("returns red when the verification bundle itself is not verified", () => {
    const result = assessLegitimacy({
      opportunityId: VERIFIED.opportunityId,
      verification: { ...VERIFIED, status: "expired" },
      observations: SAFE_OBSERVATIONS,
      assessedAt: "2026-08-28T08:07:00.000Z"
    });

    expect(result.tier).toBe("red");
    expect(result.signals.map((signal) => signal.code)).toContain("verification-not-current");
  });
});
