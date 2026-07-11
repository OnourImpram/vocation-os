import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLedgerEntry, createActionId } from "../../src/action-ledger.js";
import { decideAutoApply, type AutoApplyInput } from "../../src/auto-apply.js";
import { DEMO_DOCUMENT_ROOT, demoApprovalReference, demoGraph, demoPacket, enabledConfig, noHighStakesFlags, noRiskSignals } from "../fixtures.js";

describe("v0.3.1 release blockers", () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "vocation-release-blocker-"));
    ledgerPath = path.join(tempDir, "ledger.jsonl");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("requires approval for R3 even when the packet says approval is not required", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket("verified", { approvalRequired: false }),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      riskSignals: noRiskSignals(),
      highStakesFlags: noHighStakesFlags(),
      documentRoot: DEMO_DOCUMENT_ROOT,
      ledgerPath
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("approval-required");
  });

  it("rejects a structurally incomplete risk observation", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: {} as ReturnType<typeof noRiskSignals>,
      highStakesFlags: noHighStakesFlags(),
      documentRoot: DEMO_DOCUMENT_ROOT,
      ledgerPath
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("risk-signals-incomplete");
  });

  it("does not allow a caller usage count to override the authoritative ledger", () => {
    appendLedgerEntry(ledgerPath, {
      actionId: createActionId(new Date("2026-07-04T00:00:00.000Z")),
      timestamp: "2026-07-04T00:00:00.000Z",
      mode: "/auto-apply-config",
      opportunityId: "OPP-EXISTING-001",
      reversibilityTag: "R3",
      evidenceGatePassed: true,
      approvalRequired: true,
      approvalReceived: true,
      highStakesGatePassed: true,
      result: "submitted"
    });
    const config = enabledConfig();
    config.rateLimit.maxPerDay = 1;

    const forgedInput: AutoApplyInput & { dailyUsageCount: number } = {
      config,
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      highStakesFlags: noHighStakesFlags(),
      documentRoot: DEMO_DOCUMENT_ROOT,
      dailyUsageCount: 0,
      ledgerPath,
      now: new Date("2026-07-04T01:00:00.000Z")
    };
    const decision = decideAutoApply(forgedInput);

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("rate-limit-exhausted");
  });

  it("rejects a packet document whose content cannot be resolved", () => {
    const packet = demoPacket("verified", {
      documents: [
        {
          kind: "cv",
          path: "missing-cv.pdf",
          contentHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
        }
      ]
    });
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet,
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference({ packet }),
      riskSignals: noRiskSignals(),
      highStakesFlags: noHighStakesFlags(),
      documentRoot: DEMO_DOCUMENT_ROOT,
      ledgerPath
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("document-not-found");
  });

  it("rejects stale evidence for a recency governed claim", () => {
    const staleGraph = demoGraph({
      claims: [
        {
          ...demoGraph().claims[0]!,
          verifiedDate: "2010-01-01",
          recencyRequired: true,
          recencyPolicyId: "legal-regulatory"
        }
      ]
    });
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: staleGraph,
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      highStakesFlags: noHighStakesFlags(),
      documentRoot: DEMO_DOCUMENT_ROOT,
      ledgerPath,
      now: new Date("2026-07-11T00:00:00.000Z")
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe("stale-evidence");
  });

  it("does not let config data enable an unshipped execution adapter", () => {
    const config = enabledConfig();
    config.adapterAllowlist.push("greenhouse");
    const decision = decideAutoApply({
      config,
      packet: demoPacket(),
      claimGraph: demoGraph(),
      reversibilityTag: "R3",
      adapterId: "greenhouse",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      highStakesFlags: noHighStakesFlags(),
      documentRoot: DEMO_DOCUMENT_ROOT,
      ledgerPath
    });
    expect(decision.blockedBy).toBe("execution-adapter-not-shipped");
  });

  it("limits the shipped local fixture decision path to synthetic profiles", () => {
    const decision = decideAutoApply({
      config: enabledConfig(),
      packet: demoPacket(),
      claimGraph: demoGraph({ profileScope: "local-private" }),
      reversibilityTag: "R3",
      adapterId: "local-fixture",
      approvalReference: demoApprovalReference(),
      riskSignals: noRiskSignals(),
      highStakesFlags: noHighStakesFlags(),
      documentRoot: DEMO_DOCUMENT_ROOT,
      ledgerPath
    });
    expect(decision.blockedBy).toBe("local-fixture-requires-synthetic-profile");
  });
});
