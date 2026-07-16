export const AGENT_CLIENT_IDS = [
  "codex",
  "claude-code",
  "opencode",
  "gemini-antigravity",
  "qwen",
  "kimi",
  "grok",
  "github-copilot"
] as const;

export const AGENT_SUPPORT_LEVELS = ["discovered", "invocable", "verified"] as const;

export type AgentClientId = (typeof AGENT_CLIENT_IDS)[number];
export type AgentSupportLevel = (typeof AGENT_SUPPORT_LEVELS)[number];

export const INTEGRATION_MANIFEST_FILES: Readonly<Record<AgentClientId, string>> = Object.freeze({
  codex: "codex.json",
  "claude-code": "claude-code.json",
  opencode: "opencode.json",
  "gemini-antigravity": "gemini-antigravity.json",
  qwen: "qwen.json",
  kimi: "kimi.json",
  grok: "grok.json",
  "github-copilot": "github-copilot.json"
});

export interface AgentSkillIntegrationManifest {
  schemaVersion: 1;
  clientId: AgentClientId;
  displayName: string;
  aliases: readonly string[];
  protocol: "open-agent-skills";
  skill: {
    directory: "vocation-os";
    entrypoint: "SKILL.md";
  };
  support: {
    level: AgentSupportLevel;
    verifiedAt: string | null;
  };
  installation: {
    strategy: "copy";
    destination: "client-resolved";
    requiresExplicitDestination: true;
  };
  authority: {
    reads: "daemon-or-mcp";
    sideEffects: "capability-and-scoped-approval";
    directStorage: false;
  };
}

export class AgentSkillManifestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AgentSkillManifestError";
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentSkillManifestError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new AgentSkillManifestError(`${field} must be a non-empty string`);
  }
  return value;
}

export function validateIntegrationManifest(value: unknown): AgentSkillIntegrationManifest {
  const manifest = record(value, "Integration manifest");
  if (manifest.schemaVersion !== 1) throw new AgentSkillManifestError("schemaVersion must be 1");
  if (!AGENT_CLIENT_IDS.includes(manifest.clientId as AgentClientId)) {
    throw new AgentSkillManifestError("clientId is not supported");
  }
  const clientId = manifest.clientId as AgentClientId;
  const displayName = nonEmpty(manifest.displayName, "displayName");
  if (!Array.isArray(manifest.aliases) || manifest.aliases.length === 0) {
    throw new AgentSkillManifestError("aliases must be a non-empty array");
  }
  const aliases = manifest.aliases.map((alias, index) => nonEmpty(alias, `aliases[${index}]`));
  if (new Set(aliases).size !== aliases.length) {
    throw new AgentSkillManifestError("aliases must be unique");
  }
  if (manifest.protocol !== "open-agent-skills") {
    throw new AgentSkillManifestError("protocol must be open-agent-skills");
  }

  const skill = record(manifest.skill, "skill");
  if (skill.directory !== "vocation-os" || skill.entrypoint !== "SKILL.md") {
    throw new AgentSkillManifestError("skill must point to vocation-os/SKILL.md");
  }
  const support = record(manifest.support, "support");
  if (!AGENT_SUPPORT_LEVELS.includes(support.level as AgentSupportLevel)) {
    throw new AgentSkillManifestError("support.level is invalid");
  }
  const supportLevel = support.level as AgentSupportLevel;
  if (support.verifiedAt !== null && typeof support.verifiedAt !== "string") {
    throw new AgentSkillManifestError("support.verifiedAt must be a string or null");
  }
  if (supportLevel === "verified" && typeof support.verifiedAt !== "string") {
    throw new AgentSkillManifestError("verified integrations require support.verifiedAt");
  }
  if (typeof support.verifiedAt === "string" && !Number.isFinite(Date.parse(support.verifiedAt))) {
    throw new AgentSkillManifestError("support.verifiedAt must be an ISO-compatible timestamp");
  }

  const installation = record(manifest.installation, "installation");
  if (
    installation.strategy !== "copy"
    || installation.destination !== "client-resolved"
    || installation.requiresExplicitDestination !== true
  ) {
    throw new AgentSkillManifestError("installation must require an explicit client-resolved copy destination");
  }
  const authority = record(manifest.authority, "authority");
  if (
    authority.reads !== "daemon-or-mcp"
    || authority.sideEffects !== "capability-and-scoped-approval"
    || authority.directStorage !== false
  ) {
    throw new AgentSkillManifestError("authority boundary is invalid");
  }

  return Object.freeze({
    schemaVersion: 1,
    clientId,
    displayName,
    aliases: Object.freeze(aliases),
    protocol: "open-agent-skills",
    skill: Object.freeze({ directory: "vocation-os", entrypoint: "SKILL.md" }),
    support: Object.freeze({
      level: supportLevel,
      verifiedAt: support.verifiedAt as string | null
    }),
    installation: Object.freeze({
      strategy: "copy",
      destination: "client-resolved",
      requiresExplicitDestination: true
    }),
    authority: Object.freeze({
      reads: "daemon-or-mcp",
      sideEffects: "capability-and-scoped-approval",
      directStorage: false
    })
  });
}
