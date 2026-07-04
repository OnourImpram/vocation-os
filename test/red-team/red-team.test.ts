import { describe, expect, it } from "vitest";
import { decideAutoApply } from "../../src/auto-apply.js";
import { computeClaimTextHash } from "../../src/hash.js";
import { demoApprovalReference, demoGraph, demoPacket, enabledConfig, noRiskSignals } from "../fixtures.js";

describe("red team gates", () => {
  it("blocks visa sensitive auto apply even with approval reference", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0,
      highStakesFlags: { immigrationSensitive: true }
    });
    expect(decision.blockedBy).toBe("high-stakes-requires-manual-review");
  });

  it("blocks unsupported public claim even when action is otherwise allowed", () => {
    const unsafeGraph = demoGraph({
      claims: [{ ...demoGraph().claims[0]!, publiclyAssertable: false }],
      validationSummary: { verifiedClaims: 1, unverifiedClaims: 0, privateClaims: 1 }
    });
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: unsafeGraph,
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.blockedBy).toBe("claim-not-publicly-assertable");
  });

  it("blocks fabricated packet claim id", () => {
    const fabricatedPacket = demoPacket("verified", {
      claims: [{ ...demoPacket().claims[0]!, claimId: "CLM-FAKE-999" }]
    });
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: fabricatedPacket,
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("missing-claim");
  });

  it("blocks packet claim text inflation under an existing verified claim id", () => {
    const forgedPacket = demoPacket("verified", {
      claims: [
        {
          ...demoPacket().claims[0]!,
          text: "Demo operator won a Nobel Prize and holds a restricted license."
        }
      ]
    });
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: forgedPacket,
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("claim-text-mismatch");
  });

  it("blocks source claim text hash mismatch", () => {
    const forgedPacket = demoPacket("verified", {
      claims: [
        {
          ...demoPacket().claims[0]!,
          sourceClaimTextHash: computeClaimTextHash("different claim text")
        }
      ]
    });
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: forgedPacket,
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.blockedBy).toBe("claim-text-mismatch");
  });

  it("blocks stale packet hash", () => {
    const stalePacket = demoPacket("verified", {
      packetHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    });
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: stalePacket,
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.blockedBy).toBe("packet-hash-mismatch");
  });

  it("blocks duplicate packet claims", () => {
    const basePacket = demoPacket();
    const duplicatedPacket = demoPacket("verified", {
      claims: [basePacket.claims[0]!, basePacket.claims[0]!]
    });
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: duplicatedPacket,
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.blockedBy).toBe("duplicate-packet-claim");
  });

  it.each([
    ["captcha-present", { captchaPresent: true }],
    ["anti-bot-detected", { antiBotDetected: true }],
    ["payment-required", { paymentRequired: true }],
    ["identity-check-required", { identityCheckRequired: true }],
    ["tos-unclear", { tosUnclear: true }],
    ["unsupported-license-claim", { unsupportedLicenseClaim: true }],
    ["credential-fabrication-requested", { credentialFabricationRequested: true }]
  ])("blocks automation risk signal %s", (expected, signal) => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: { ...noRiskSignals(), ...signal },
      dailyUsageCount: 0
    });
    expect(decision.blockedBy).toBe(expected);
  });
});
