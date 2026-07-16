import { describe, expect, it } from "vitest";
import {
  AGENT_CLI_IDS,
  AGENT_INTEGRATION_MANIFESTS,
  evaluateAgentIntegration,
  summarizeAgentIntegrations,
  type AgentIntegrationProbe
} from "../../src/agents/index.js";

const checkedAt = "2026-07-14T12:00:00.000Z";

function probe(overrides: Partial<AgentIntegrationProbe> = {}): AgentIntegrationProbe {
  return {
    agentId: "codex",
    detectedBinary: "codex",
    invocationSucceeded: true,
    conformancePassed: true,
    daemonAuthorityConfirmed: true,
    checkedAt,
    diagnostics: [],
    ...overrides
  };
}

describe("agent integration manifests", () => {
  it("defines every required CLI without granting direct write authority", () => {
    expect(AGENT_INTEGRATION_MANIFESTS.map((manifest) => manifest.agentId)).toEqual(AGENT_CLI_IDS);
    expect(AGENT_INTEGRATION_MANIFESTS.every((manifest) => manifest.daemonOnlyWrites)).toBe(true);
    expect(AGENT_INTEGRATION_MANIFESTS.every((manifest) => manifest.defaultCapability === "read-only")).toBe(true);
  });

  it("separates discovered, invocable, and verified support", () => {
    expect(evaluateAgentIntegration(probe({ invocationSucceeded: false, conformancePassed: false, daemonAuthorityConfirmed: false })).level).toBe("discovered");
    expect(evaluateAgentIntegration(probe({ conformancePassed: false, daemonAuthorityConfirmed: false })).level).toBe("invocable");
    expect(evaluateAgentIntegration(probe()).level).toBe("verified");
  });

  it("rejects impossible conformance claims", () => {
    expect(() => evaluateAgentIntegration(probe({ detectedBinary: null }))).toThrow(/without a detected binary/);
    expect(() => evaluateAgentIntegration(probe({ invocationSucceeded: false }))).toThrow(/before invocation/);
  });

  it("rejects duplicate probes instead of inflating support counts", () => {
    expect(() => summarizeAgentIntegrations([probe(), probe()])).toThrow(/Duplicate/);
  });

  it("reports support counts from evidence", () => {
    const report = summarizeAgentIntegrations([
      probe(),
      probe({ agentId: "claude-code", detectedBinary: "claude", conformancePassed: false, daemonAuthorityConfirmed: false }),
      probe({ agentId: "opencode", detectedBinary: null, invocationSucceeded: false, conformancePassed: false, daemonAuthorityConfirmed: false })
    ]);
    expect(report.counts).toEqual({ "not-detected": 1, discovered: 0, invocable: 1, verified: 1 });
  });
});
