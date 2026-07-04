import { describe, expect, it } from "vitest";
import { decideAutoApply } from "../../src/auto-apply.js";
import { demoApprovalReference, demoGraph, demoPacket, enabledConfig, noRiskSignals } from "../fixtures.js";

describe("golden gate output", () => {
  it("keeps unverified packet decision stable", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket("unverified"),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0,
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(decision).toMatchObject({
      allowed: false,
      blockedBy: "packet-evidence-not-verified",
      confirmationEvidenceRequired: true
    });
  });
});
