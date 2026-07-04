import { describe, expect, it } from "vitest";
import { decideAutoApply, engageKillSwitch } from "../../src/auto-apply.js";
import { demoApprovalReference, demoGraph, demoPacket, enabledConfig, noRiskSignals } from "../fixtures.js";

describe("auto apply", () => {
  it("blocks first when kill switch is engaged", () => {
    const decision = decideAutoApply({
      config: engageKillSwitch(enabledConfig(), "tester", "test"),
      packet: demoPacket("unverified"),
      claimGraph: demoGraph(),
      reversibilityTag: "R4",
      adapterId: "unknown"
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("kill-switch-engaged");
  });

  it("blocks any unverified packet claim", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket("unverified"),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("packet-evidence-not-verified");
  });

  it("blocks R4 actions", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R4",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.blockedBy).toBe("r4-not-auto-submittable");
  });

  it("does not let opportunity override bypass high stakes", () => {
    const config = enabledConfig();
    config.perOpportunity["OPP-DEMO-001"] = { mode: "auto" };
    const decision = decideAutoApply({
      config,
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0,
      highStakesFlags: { licensingSensitive: true }
    });
    expect(decision.blockedBy).toBe("high-stakes-requires-manual-review");
  });

  it("requires approval before allowed automation", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      riskSignals: noRiskSignals(),
      dailyUsageCount: 0
    });
    expect(decision.blockedBy).toBe("approval-required");
  });

  it("blocks when risk signals are missing", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      dailyUsageCount: 0
    });
    expect(decision.blockedBy).toBe("risk-signals-missing");
  });
});
