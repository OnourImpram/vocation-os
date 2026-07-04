import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendLedgerEntry, createActionId, readLedger } from "../../src/action-ledger.js";
import { decideAutoApply } from "../../src/auto-apply.js";
import { demoApprovalReference, demoGraph, demoPacket, enabledConfig, noRiskSignals } from "../fixtures.js";

describe("action ledger", () => {
  it("records blocked auto apply attempts when a ledger path is provided", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-ledger-"));
    const ledgerPath = path.join(dir, "ledger.jsonl");
    try {
      const decision = decideAutoApply({
        config: enabledConfig(),
        packet: demoPacket("unverified"),
        claimGraph: demoGraph(),
        reversibilityTag: "R3",
        adapterId: "local-fixture",
        approvalReference: demoApprovalReference(),
        riskSignals: noRiskSignals(),
        ledgerPath,
        now: new Date("2026-07-04T00:00:00.000Z")
      });
      expect(decision.blockedBy).toBe("packet-evidence-not-verified");
      const entries = readLedger(ledgerPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.result).toBe("blocked");
      expect(entries[0]?.blockedBy).toBe("packet-evidence-not-verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates unique action ids for repeated decisions", () => {
    const first = createActionId(new Date("2026-07-04T00:00:00.000Z"));
    const second = createActionId(new Date("2026-07-04T00:00:00.000Z"));
    expect(first).not.toBe(second);
    expect(first).toMatch(/^A-2026-[0-9a-f-]{36}$/);
  });

  it("rejects duplicate ledger ids", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-ledger-"));
    const ledgerPath = path.join(dir, "ledger.jsonl");
    const entry = {
      actionId: createActionId(new Date("2026-07-04T00:00:00.000Z")),
      timestamp: "2026-07-04T00:00:00.000Z",
      mode: "/auto-apply-config",
      opportunityId: "OPP-DEMO-001",
      reversibilityTag: "R3" as const,
      evidenceGatePassed: true,
      approvalRequired: true,
      approvalReceived: true,
      highStakesGatePassed: true,
      result: "draft_generated" as const
    };
    try {
      appendLedgerEntry(ledgerPath, entry);
      expect(() => appendLedgerEntry(ledgerPath, entry)).toThrow(/Duplicate action id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when daily ledger usage reaches maxPerDay", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-ledger-"));
    const ledgerPath = path.join(dir, "ledger.jsonl");
    try {
      appendLedgerEntry(ledgerPath, {
        actionId: createActionId(new Date("2026-07-04T00:00:00.000Z")),
        timestamp: "2026-07-04T01:00:00.000Z",
        mode: "/auto-apply-config",
        opportunityId: "OPP-DEMO-001",
        reversibilityTag: "R3",
        evidenceGatePassed: true,
        approvalRequired: true,
        approvalReceived: true,
        highStakesGatePassed: true,
        result: "draft_generated"
      });
      const config = enabledConfig();
      config.rateLimit.maxPerDay = 1;
      const decision = decideAutoApply({
        config,
        packet: demoPacket(),
        claimGraph: demoGraph(),
        reversibilityTag: "R3",
        adapterId: "local-fixture",
        approvalReference: demoApprovalReference(),
        riskSignals: noRiskSignals(),
        ledgerPath,
        now: new Date("2026-07-04T02:00:00.000Z")
      });
      expect(decision.blockedBy).toBe("rate-limit-exhausted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
