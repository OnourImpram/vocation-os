import { computeClaimTextHash, computePacketHash } from "../src/hash.js";
import { defaultAutoApplyConfig } from "../src/auto-apply.js";
import type { ApplicationPacket, ApprovalReference, AutomationRiskSignals, AutoApplyConfig, ClaimGraph } from "../src/types.js";

export const DEMO_CLAIM_TEXT = "Demo operator completed a synthetic project.";

export function demoApprovalReference(): ApprovalReference {
  return {
    approvalId: "APR-TEST-001",
    approvedBy: "test-operator",
    approvedAt: "2026-07-04T00:00:00.000Z",
    approvalTextHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555"
  };
}

export function noRiskSignals(): AutomationRiskSignals {
  return {
    captchaPresent: false,
    antiBotDetected: false,
    paymentRequired: false,
    identityCheckRequired: false,
    tosUnclear: false,
    unsupportedLicenseClaim: false,
    credentialFabricationRequested: false
  };
}

export function enabledConfig(): AutoApplyConfig {
  return {
    ...defaultAutoApplyConfig(),
    enabled: true,
    mode: "auto"
  };
}

export function demoGraph(overrides: Partial<ClaimGraph> = {}): ClaimGraph {
  const graph: ClaimGraph = {
    profileId: "DEMO-OPERATOR-001",
    profileScope: "synthetic",
    generatedAt: "2026-07-04T00:00:00.000Z",
    graphVersion: "0.2.0",
    claims: [
      {
        claimId: "CLM-DEMO-001",
        text: DEMO_CLAIM_TEXT,
        canonicalTextHash: computeClaimTextHash(DEMO_CLAIM_TEXT),
        claimType: "project",
        evidenceStatus: "verified",
        sourceType: "operator-supplied",
        sourcePointer: "examples/demo-profile/source.md#project",
        verifiedDate: "2026-07-04",
        recencyRequired: false,
        publiclyAssertable: true,
        allowedInCv: true,
        allowedInOutreach: true,
        allowedInAutoApply: true
      }
    ],
    validationSummary: {
      verifiedClaims: 1,
      unverifiedClaims: 0,
      privateClaims: 0
    }
  };
  return { ...graph, ...overrides };
}

export function demoPacket(evidenceStatus: "verified" | "unverified" = "verified", overrides: Partial<ApplicationPacket> = {}): ApplicationPacket {
  const packet: ApplicationPacket = {
    opportunityId: "OPP-DEMO-001",
    claims: [
      {
        claimId: "CLM-DEMO-001",
        text: DEMO_CLAIM_TEXT,
        sourceClaimTextHash: computeClaimTextHash(DEMO_CLAIM_TEXT),
        evidenceStatus,
        sourcePointer: "examples/demo-profile/source.md#project",
        publiclyAssertable: true
      }
    ],
    documents: [{ kind: "cv", contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
    tosCompliant: true,
    generatedAt: "2026-07-04T00:00:00.000Z",
    packetHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    approvalRequired: true,
    ...overrides
  };
  return {
    ...packet,
    packetHash: overrides.packetHash ?? computePacketHash(packet)
  };
}
