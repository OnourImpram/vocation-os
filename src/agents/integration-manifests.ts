import { sha256, stableStringify } from "../hash.js";

export const AGENT_CLI_IDS = [
  "codex",
  "claude-code",
  "opencode",
  "gemini",
  "antigravity",
  "qwen-code",
  "kimi-cli",
  "grok",
  "github-copilot-cli"
] as const;

export type AgentCliId = (typeof AGENT_CLI_IDS)[number];
export type AgentSupportLevel = "not-detected" | "discovered" | "invocable" | "verified";

export interface AgentIntegrationManifest {
  agentId: AgentCliId;
  displayName: string;
  binaryCandidates: readonly string[];
  skillInstallTarget: string;
  protocol: "open-agent-skills";
  protocolReference: "https://openagentskills.dev/docs/specification";
  daemonOnlyWrites: true;
  defaultCapability: "read-only";
  supportedCapabilities: readonly (
    | "profile-read"
    | "opportunity-read"
    | "assurance-read"
    | "review-proposal"
    | "document-proposal"
    | "authorized-command"
  )[];
}

export interface AgentIntegrationProbe {
  agentId: AgentCliId;
  detectedBinary: string | null;
  invocationSucceeded: boolean;
  conformancePassed: boolean;
  daemonAuthorityConfirmed: boolean;
  checkedAt: string;
  diagnostics: readonly string[];
}

export interface AgentIntegrationStatus {
  agentId: AgentCliId;
  level: AgentSupportLevel;
  checkedAt: string;
  detectedBinary: string | null;
  reasons: string[];
  manifestHash: string;
  probeHash: string;
}

export const AGENT_INTEGRATION_MANIFESTS: readonly AgentIntegrationManifest[] = [
  manifest("codex", "OpenAI Codex", ["codex"], ".agents/skills/vocation-os"),
  manifest("claude-code", "Claude Code", ["claude"], ".claude/skills/vocation-os"),
  manifest("opencode", "OpenCode", ["opencode"], ".opencode/skills/vocation-os"),
  manifest("gemini", "Gemini CLI", ["gemini"], ".gemini/skills/vocation-os"),
  manifest("antigravity", "Antigravity", ["antigravity"], ".antigravity/skills/vocation-os"),
  manifest("qwen-code", "Qwen Code", ["qwen", "qwen-code"], ".qwen/skills/vocation-os"),
  manifest("kimi-cli", "Kimi CLI", ["kimi"], ".kimi/skills/vocation-os"),
  manifest("grok", "Grok CLI", ["grok"], ".grok/skills/vocation-os"),
  manifest("github-copilot-cli", "GitHub Copilot CLI", ["gh", "github-copilot"], ".github/skills/vocation-os")
] as const;

function manifest(
  agentId: AgentCliId,
  displayName: string,
  binaryCandidates: readonly string[],
  skillInstallTarget: string
): AgentIntegrationManifest {
  return {
    agentId,
    displayName,
    binaryCandidates,
    skillInstallTarget,
    protocol: "open-agent-skills",
    protocolReference: "https://openagentskills.dev/docs/specification",
    daemonOnlyWrites: true,
    defaultCapability: "read-only",
    supportedCapabilities: [
      "profile-read",
      "opportunity-read",
      "assurance-read",
      "review-proposal",
      "document-proposal",
      "authorized-command"
    ]
  };
}

function assertIsoTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Agent integration probe timestamp is invalid");
}

export function agentIntegrationManifest(agentId: AgentCliId): AgentIntegrationManifest {
  const result = AGENT_INTEGRATION_MANIFESTS.find((candidate) => candidate.agentId === agentId);
  if (!result) throw new Error(`Agent integration manifest is missing: ${agentId}`);
  return result;
}

export function evaluateAgentIntegration(probe: AgentIntegrationProbe): AgentIntegrationStatus {
  assertIsoTimestamp(probe.checkedAt);
  const manifestValue = agentIntegrationManifest(probe.agentId);
  const reasons: string[] = [];
  let level: AgentSupportLevel = "not-detected";

  if (probe.detectedBinary !== null) {
    if (!manifestValue.binaryCandidates.includes(probe.detectedBinary)) {
      throw new Error("Agent integration probe references an unexpected binary");
    }
    level = "discovered";
  } else {
    reasons.push("binary-not-detected");
  }

  if (probe.invocationSucceeded) {
    if (level === "not-detected") throw new Error("Agent invocation cannot succeed without a detected binary");
    level = "invocable";
  } else if (probe.detectedBinary !== null) {
    reasons.push("invocation-not-confirmed");
  }

  if (probe.conformancePassed && probe.daemonAuthorityConfirmed) {
    if (level !== "invocable") throw new Error("Agent conformance cannot pass before invocation is confirmed");
    level = "verified";
  } else if (probe.invocationSucceeded) {
    if (!probe.conformancePassed) reasons.push("conformance-not-passed");
    if (!probe.daemonAuthorityConfirmed) reasons.push("daemon-authority-not-confirmed");
  }

  return {
    agentId: probe.agentId,
    level,
    checkedAt: probe.checkedAt,
    detectedBinary: probe.detectedBinary,
    reasons: [...reasons, ...probe.diagnostics],
    manifestHash: sha256(stableStringify(manifestValue)),
    probeHash: sha256(stableStringify(probe))
  };
}

export function summarizeAgentIntegrations(probes: readonly AgentIntegrationProbe[]): {
  statuses: AgentIntegrationStatus[];
  counts: Record<AgentSupportLevel, number>;
} {
  const seen = new Set<AgentCliId>();
  const statuses = probes.map((probe) => {
    if (seen.has(probe.agentId)) throw new Error(`Duplicate agent integration probe: ${probe.agentId}`);
    seen.add(probe.agentId);
    return evaluateAgentIntegration(probe);
  });
  const counts: Record<AgentSupportLevel, number> = {
    "not-detected": 0,
    discovered: 0,
    invocable: 0,
    verified: 0
  };
  for (const status of statuses) counts[status.level] += 1;
  return { statuses, counts };
}
