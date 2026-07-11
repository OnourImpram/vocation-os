import { appendLedgerEntry, createActionId, readLedger } from "./action-ledger.js";
import { validateApprovalReference, type TrustedApprover } from "./approval.js";
import { validateApplicationPacket } from "./claim-graph.js";
import { validateAgainstSchema } from "./schema.js";
import { HIGH_STAKES_FLAGS, type ActionLedgerEntry, type ApplicationPacket, type ApprovalReference, type AutomationRiskSignals, type AutoApplyConfig, type AutoApplyDecision, type ClaimGraph, type HighStakesFlags, type ReversibilityTag } from "./types.js";

export const REARM_TOKEN = "REARM-AUTO-APPLY";

export interface AutoApplyInput {
  config: AutoApplyConfig;
  packet: ApplicationPacket;
  claimGraph: ClaimGraph;
  reversibilityTag: ReversibilityTag;
  highStakesFlags?: HighStakesFlags;
  adapterId: string;
  approvalReference?: ApprovalReference;
  trustedApprovers?: readonly TrustedApprover[];
  riskSignals?: AutomationRiskSignals;
  documentRoot?: string;
  ledgerPath?: string;
  now?: Date;
}

export function defaultAutoApplyConfig(): AutoApplyConfig {
  return {
    enabled: false,
    mode: "manual",
    killSwitch: {
      available: true,
      engaged: false
    },
    rateLimit: {
      maxPerDay: 5
    },
    adapterAllowlist: ["local-fixture"],
    perOpportunity: {},
    exclusionRules: [
      "captcha",
      "anti-bot",
      "payment",
      "identity-check",
      "credential-fabrication",
      "unsupported-license-claim",
      "tos-unclear"
    ]
  };
}

function blocked(blockedBy: string, reasons: string[], actionId?: string): AutoApplyDecision {
  const decision: AutoApplyDecision = {
    allowed: false,
    blockedBy,
    reasons,
    requiredApprovals: [],
    confirmationEvidenceRequired: true
  };
  if (actionId) {
    decision.ledgerActionId = actionId;
  }
  return decision;
}

function hasHighStakes(flags: HighStakesFlags | undefined): boolean {
  return HIGH_STAKES_FLAGS.some((flag) => flags?.[flag] === true);
}

const SHIPPED_EXECUTION_ADAPTERS = ["local-fixture"] as const;

function hasCompleteHighStakesAssessment(flags: HighStakesFlags | undefined): boolean {
  return Boolean(flags) && HIGH_STAKES_FLAGS.every((flag) => typeof flags?.[flag] === "boolean");
}

function effectiveMode(config: AutoApplyConfig, opportunityId: string): AutoApplyConfig["mode"] {
  const override = config.perOpportunity[opportunityId];
  return override?.mode ?? config.mode;
}

function isInCooldown(config: AutoApplyConfig, now: Date): boolean {
  if (!config.rateLimit.cooldownUntil) {
    return false;
  }
  return Date.parse(config.rateLimit.cooldownUntil) > now.getTime();
}

function blockingRiskSignal(signals: AutomationRiskSignals): string | null {
  if (signals.captchaPresent) {
    return "captcha-present";
  }
  if (signals.antiBotDetected) {
    return "anti-bot-detected";
  }
  if (signals.paymentRequired) {
    return "payment-required";
  }
  if (signals.identityCheckRequired) {
    return "identity-check-required";
  }
  if (signals.tosUnclear) {
    return "tos-unclear";
  }
  if (signals.unsupportedLicenseClaim) {
    return "unsupported-license-claim";
  }
  if (signals.credentialFabricationRequested) {
    return "credential-fabrication-requested";
  }
  return null;
}

const RISK_SIGNAL_KEYS = [
  "captchaPresent",
  "antiBotDetected",
  "paymentRequired",
  "identityCheckRequired",
  "tosUnclear",
  "unsupportedLicenseClaim",
  "credentialFabricationRequested"
] as const satisfies readonly (keyof AutomationRiskSignals)[];

function hasCompleteRiskSignals(signals: AutomationRiskSignals | undefined): signals is AutomationRiskSignals {
  return Boolean(signals) && RISK_SIGNAL_KEYS.every((key) => typeof signals?.[key] === "boolean");
}

function dailyUsage(input: AutoApplyInput, now: Date): { usage: number | null; error?: string } {
  if (!input.ledgerPath) {
    return { usage: null };
  }
  try {
    const day = now.toISOString().slice(0, 10);
    const opportunityIds = new Set(
      readLedger(input.ledgerPath)
        .filter((entry) => {
          const resultCounts = entry.result === "draft_generated" || entry.result === "submitted" || entry.result === "confirmed";
          return resultCounts && entry.timestamp.slice(0, 10) === day;
        })
        .map((entry) => entry.opportunityId)
    );
    return { usage: opportunityIds.size };
  } catch (error) {
    return { usage: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function decideAutoApply(input: AutoApplyInput): AutoApplyDecision {
  const actionId = createActionId(input.now ?? new Date());
  const finalize = (decision: AutoApplyDecision): AutoApplyDecision => recordDecision(input, decision);
  const configValidation = validateAgainstSchema("auto-apply-config", input.config);
  if (!configValidation.valid) {
    return finalize(blocked("config-schema-invalid", configValidation.errors, actionId));
  }
  const packetSchemaValidation = validateAgainstSchema("application-packet", input.packet);
  if (!packetSchemaValidation.valid) {
    return finalize(blocked("packet-schema-invalid", packetSchemaValidation.errors, actionId));
  }

  if (input.config.killSwitch.engaged) {
    return finalize(blocked("kill-switch-engaged", ["kill switch is engaged"], actionId));
  }
  if (!input.config.enabled) {
    return finalize(blocked("auto-apply-disabled", ["auto apply is disabled"], actionId));
  }
  if (effectiveMode(input.config, input.packet.opportunityId) !== "auto") {
    return finalize(blocked("mode-not-auto", ["effective mode is not auto"], actionId));
  }
  if (input.config.perOpportunity[input.packet.opportunityId]?.excluded === true) {
    return finalize(blocked("opportunity-excluded", ["opportunity is explicitly excluded"], actionId));
  }
  if (!SHIPPED_EXECUTION_ADAPTERS.some((adapter) => adapter === input.adapterId)) {
    return finalize(blocked("execution-adapter-not-shipped", [`adapter ${input.adapterId} has no shipped execution authority`], actionId));
  }
  if (input.adapterId === "local-fixture" && input.claimGraph.profileScope !== "synthetic") {
    return finalize(blocked("local-fixture-requires-synthetic-profile", ["local fixture execution is limited to synthetic profiles"], actionId));
  }
  if (!input.config.adapterAllowlist.includes(input.adapterId)) {
    return finalize(blocked("adapter-not-allowlisted", [`adapter ${input.adapterId} is not allowlisted`], actionId));
  }
  if (input.reversibilityTag === "R4") {
    return finalize(blocked("r4-not-auto-submittable", ["R4 action cannot be auto submitted"], actionId));
  }
  if (!hasCompleteHighStakesAssessment(input.highStakesFlags)) {
    return finalize(blocked("high-stakes-assessment-incomplete", ["all high stakes flags require explicit assessment"], actionId));
  }
  if (hasHighStakes(input.highStakesFlags)) {
    return finalize(blocked("high-stakes-requires-manual-review", ["high stakes route requires human specialist review"], actionId));
  }
  if (!input.riskSignals) {
    return finalize(blocked("risk-signals-missing", ["automation risk signals are required for auto mode"], actionId));
  }
  if (!hasCompleteRiskSignals(input.riskSignals)) {
    return finalize(blocked("risk-signals-incomplete", ["all automation risk signals require explicit boolean observations"], actionId));
  }
  const riskBlock = blockingRiskSignal(input.riskSignals);
  if (riskBlock) {
    return finalize(blocked(riskBlock, [`${riskBlock} must not be bypassed`], actionId));
  }
  if (input.config.rateLimit.maxPerDay < 1) {
    return finalize(blocked("rate-limit-exhausted", ["daily rate limit is exhausted"], actionId));
  }
  const usageResult = dailyUsage(input, input.now ?? new Date());
  if (usageResult.error) {
    return finalize(blocked("rate-limit-ledger-invalid", [usageResult.error], actionId));
  }
  if (usageResult.usage === null) {
    return finalize(blocked("rate-limit-state-missing", ["authoritative ledger path is required for rate limit enforcement"], actionId));
  }
  if (usageResult.usage >= input.config.rateLimit.maxPerDay) {
    return finalize(blocked("rate-limit-exhausted", ["daily rate limit is exhausted"], actionId));
  }
  if (isInCooldown(input.config, input.now ?? new Date())) {
    return finalize(blocked("cooldown-active", ["cooldown is active"], actionId));
  }
  if (!input.packet.tosCompliant) {
    return finalize(blocked("tos-not-compliant", ["packet terms status is not compliant"], actionId));
  }

  let packetValidation;
  try {
    packetValidation = validateApplicationPacket(input.packet, input.claimGraph, {
      now: input.now ?? new Date(),
      ...(input.documentRoot ? { documentRoot: input.documentRoot } : {})
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return finalize(blocked("packet-validation-error", [reason], actionId));
  }
  if (!packetValidation.valid) {
    const firstReason = packetValidation.reasons[0] ?? "packet-validation-failed";
    const normalized = firstReason.startsWith("packet-evidence-not-verified")
      ? "packet-evidence-not-verified"
      : firstReason.split(":")[0] ?? firstReason;
    return finalize(blocked(normalized, packetValidation.reasons, actionId));
  }

  const approvalRequired = true;
  if (approvalRequired && !input.approvalReference) {
    return finalize(blocked("approval-required", ["explicit operator approval reference is required"], actionId));
  }
  if (input.approvalReference) {
    const approvalValidation = validateApprovalReference(
      input.approvalReference,
      {
        operation: "auto-apply",
        opportunityId: input.packet.opportunityId,
        packetHash: input.packet.packetHash,
        adapterId: input.adapterId,
        reversibilityTag: input.reversibilityTag,
        requiredField: "application-packet",
        now: input.now ?? new Date()
      },
      input.trustedApprovers ?? []
    );
    if (!approvalValidation.valid) {
      return finalize(blocked(approvalValidation.blockedBy ?? "approval-invalid", approvalValidation.reasons, actionId));
    }
  }

  return finalize({
    allowed: true,
    reasons: ["all gates passed"],
    requiredApprovals: approvalRequired ? ["operator"] : [],
    ledgerActionId: actionId,
    confirmationEvidenceRequired: true
  });
}

function recordDecision(input: AutoApplyInput, decision: AutoApplyDecision): AutoApplyDecision {
  if (!input.ledgerPath) {
    return decision;
  }

  const actionId = decision.ledgerActionId ?? createActionId(input.now ?? new Date());
  const approvalRequired = true;
  try {
    const entry: ActionLedgerEntry = {
      actionId,
      timestamp: (input.now ?? new Date()).toISOString(),
      mode: "/auto-apply-config",
      opportunityId: input.packet.opportunityId,
      reversibilityTag: input.reversibilityTag,
      evidenceGatePassed: decision.allowed || decision.blockedBy === "approval-required",
      approvalRequired,
      approvalReceived: Boolean(input.approvalReference),
      highStakesGatePassed: !hasHighStakes(input.highStakesFlags),
      result: decision.allowed ? "draft_generated" : "blocked"
    };
    if (decision.blockedBy) {
      entry.blockedBy = decision.blockedBy;
    }
    appendLedgerEntry(input.ledgerPath, entry);
    return decision;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...decision,
      allowed: false,
      blockedBy: "ledger-write-failed",
      reasons: [...decision.reasons, `ledger-write-failed:${message}`],
      auditError: message
    };
  }
}

export function engageKillSwitch(config: AutoApplyConfig, engagedBy: string, reason: string, now = new Date()): AutoApplyConfig {
  return {
    ...config,
    enabled: false,
    mode: "manual",
    killSwitch: {
      available: true,
      engaged: true,
      engagedAt: now.toISOString(),
      engagedBy,
      reason
    }
  };
}

export function rearmAutoApply(config: AutoApplyConfig, token: string): AutoApplyConfig {
  if (token !== REARM_TOKEN) {
    throw new Error("Invalid rearm token");
  }
  return {
    ...config,
    enabled: false,
    mode: "manual",
    killSwitch: {
      available: true,
      engaged: false
    }
  };
}

export function enableAutoApply(config: AutoApplyConfig, mode: "draft-only" | "auto" = "draft-only"): AutoApplyConfig {
  if (config.killSwitch.engaged) {
    throw new Error("Cannot enable while kill switch is engaged");
  }
  return {
    ...config,
    enabled: true,
    mode
  };
}
