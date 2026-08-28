import { sha256, stableStringify } from "../hash.js";
import type { SubmissionObservationDraft } from "../submission-proof.js";
import type {
  AdapterExecuteContext,
  AdapterExecutionPlan,
  AdapterInspectContext,
  AdapterInspection,
  AdapterPlanContext,
  AdapterPreview,
  AdapterValidationResult,
  ExecutionAdapter,
  ExecutionAdapterManifest,
  ExecutionObservation,
  ReconciliationContext,
  ReconciliationResult
} from "./execution-adapter.js";

const ADAPTER_ID = "career-ops-local-fixture";
const ADAPTER_VERSION = "0.7.0-alpha.1";
const TARGET_DOMAIN = "synthetic.example";
const SUPPORTED_FIELDS = ["cv", "email", "name"] as const;
const FORBIDDEN_FIELDS = ["identity-document", "payment", "protected-traits"] as const;

function manifestWithoutRecipeHash(): Omit<ExecutionAdapterManifest, "recipeHash"> {
  return {
    adapterId: ADAPTER_ID,
    version: ADAPTER_VERSION,
    maturity: "synthetic",
    supportedDomains: [TARGET_DOMAIN],
    supportedProfileScopes: ["synthetic"],
    supportedActionTypes: ["submit-ats-application"],
    supportedFields: [...SUPPORTED_FIELDS],
    forbiddenFields: [...FORBIDDEN_FIELDS],
    proofKinds: ["confirmation-page"],
    requiresBrowser: false,
    requiresLogin: false,
    lastVerifiedAt: "2026-08-28T00:00:00.000Z"
  };
}

const MANIFEST: ExecutionAdapterManifest = {
  ...manifestWithoutRecipeHash(),
  recipeHash: sha256(stableStringify(manifestWithoutRecipeHash()))
};

function normalizedFields(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function inspectionBlock(blockedBy: string, reason: string): AdapterInspection {
  return { allowed: false, blockedBy, reasons: [reason] };
}

function canonicalPlan(plan: Omit<AdapterExecutionPlan, "planHash">): string {
  return stableStringify(plan);
}

function computePlanHash(plan: Omit<AdapterExecutionPlan, "planHash">): string {
  return sha256(canonicalPlan(plan));
}

function validatePlanSynchronously(plan: AdapterExecutionPlan): AdapterValidationResult {
  const reasons: string[] = [];
  if (plan.adapterId !== ADAPTER_ID) reasons.push("plan adapter does not match the local fixture adapter");
  if (plan.targetDomain !== TARGET_DOMAIN) reasons.push("plan target domain is not supported");
  if (plan.profileScope !== "synthetic") reasons.push("plan profile scope is not synthetic");
  if (plan.verificationStatus !== "verified") reasons.push("plan verification is not current");
  if (plan.legitimacyTier !== "green") reasons.push("plan legitimacy tier is not green");
  if (plan.actionType !== "submit-ats-application") reasons.push("plan action type is not supported");
  if (plan.requestedFields.some((field) => !SUPPORTED_FIELDS.includes(field as (typeof SUPPORTED_FIELDS)[number]))) {
    reasons.push("plan requests an unsupported field");
  }
  if (plan.requestedFields.some((field) => FORBIDDEN_FIELDS.includes(field as (typeof FORBIDDEN_FIELDS)[number]))) {
    reasons.push("plan requests a forbidden field");
  }
  const { planHash: _planHash, ...withoutHash } = plan;
  if (computePlanHash(withoutHash) !== plan.planHash) reasons.push("plan hash does not match the plan content");
  return { valid: reasons.length === 0, reasons };
}

export const careerOpsLocalFixtureAdapter: ExecutionAdapter = {
  manifest(): ExecutionAdapterManifest {
    return {
      ...MANIFEST,
      supportedDomains: [...MANIFEST.supportedDomains],
      supportedProfileScopes: [...MANIFEST.supportedProfileScopes],
      supportedActionTypes: [...MANIFEST.supportedActionTypes],
      supportedFields: [...MANIFEST.supportedFields],
      forbiddenFields: [...MANIFEST.forbiddenFields],
      proofKinds: [...MANIFEST.proofKinds]
    };
  },

  async inspect(context: AdapterInspectContext): Promise<AdapterInspection> {
    if (context.profileScope !== "synthetic") {
      return inspectionBlock("synthetic-profile-required", "the local fixture adapter accepts synthetic profiles only");
    }
    if (context.targetDomain.trim().toLowerCase() !== TARGET_DOMAIN) {
      return inspectionBlock("target-domain-not-supported", "the local fixture adapter accepts synthetic.example only");
    }
    if (!context.opportunityId.startsWith("OPP-")) {
      return inspectionBlock("opportunity-id-invalid", "the local fixture adapter requires a canonical opportunity id");
    }
    return { allowed: true, reasons: [] };
  },

  async plan(context: AdapterPlanContext): Promise<AdapterExecutionPlan> {
    if (context.verificationStatus !== "verified") {
      throw new Error("verification must be current before adapter planning");
    }
    if (context.legitimacyTier !== "green") {
      throw new Error("legitimacy must be green before local fixture planning");
    }
    const inspection = await this.inspect({
      opportunityId: context.command.opportunityId,
      profileScope: context.profileScope,
      targetDomain: context.command.targetDomain
    });
    if (!inspection.allowed) throw new Error(inspection.blockedBy ?? inspection.reasons.join(", "));
    if (context.command.adapterId !== ADAPTER_ID) throw new Error("outbox adapter does not match the local fixture adapter");
    if (context.command.status !== "executing") throw new Error("outbox command must be executing before adapter planning");
    if (context.command.actionType !== "submit-ats-application") throw new Error("outbox action type is not supported");

    const requestedFields = normalizedFields(context.requestedFields);
    if (requestedFields.length === 0) throw new Error("adapter plan requires at least one requested field");
    const forbidden = requestedFields.filter((field) => FORBIDDEN_FIELDS.includes(field as (typeof FORBIDDEN_FIELDS)[number]));
    if (forbidden.length > 0) throw new Error(`adapter plan requests forbidden fields: ${forbidden.join(", ")}`);
    const unsupported = requestedFields.filter((field) => !SUPPORTED_FIELDS.includes(field as (typeof SUPPORTED_FIELDS)[number]));
    if (unsupported.length > 0) throw new Error(`adapter plan requests unsupported fields: ${unsupported.join(", ")}`);

    const withoutHash: Omit<AdapterExecutionPlan, "planHash"> = {
      planId: `PLAN-${context.command.idempotencyKey.slice("sha256:".length, "sha256:".length + 20).toUpperCase()}`,
      adapterId: ADAPTER_ID,
      commandId: context.command.commandId,
      opportunityId: context.command.opportunityId,
      actionType: context.command.actionType,
      targetDomain: context.command.targetDomain,
      profileScope: context.profileScope,
      verificationStatus: context.verificationStatus,
      legitimacyTier: context.legitimacyTier,
      requestedFields,
      plannedAt: context.command.updatedAt
    };
    return { ...withoutHash, planHash: computePlanHash(withoutHash) };
  },

  async validate(plan: AdapterExecutionPlan): Promise<AdapterValidationResult> {
    return validatePlanSynchronously(plan);
  },

  async preview(plan: AdapterExecutionPlan): Promise<AdapterPreview> {
    const validation = validatePlanSynchronously(plan);
    if (!validation.valid) throw new Error(`adapter plan is invalid: ${validation.reasons.join(", ")}`);
    return {
      planId: plan.planId,
      planHash: plan.planHash,
      adapterId: plan.adapterId,
      actionType: plan.actionType,
      targetDomain: plan.targetDomain,
      requestedFields: [...plan.requestedFields],
      warnings: ["synthetic fixture execution only"]
    };
  },

  async execute(context: AdapterExecuteContext): Promise<ExecutionObservation> {
    const validation = validatePlanSynchronously(context.plan);
    if (!validation.valid) throw new Error(`adapter plan is invalid: ${validation.reasons.join(", ")}`);
    if (context.command.status !== "executing") throw new Error("outbox command must be executing before adapter execution");
    if (context.command.commandId !== context.plan.commandId) throw new Error("execution plan is bound to a different outbox command");
    if (context.command.adapterId !== ADAPTER_ID || context.plan.adapterId !== ADAPTER_ID) {
      throw new Error("execution adapter binding does not match the local fixture adapter");
    }
    if (context.command.targetDomain !== TARGET_DOMAIN || context.plan.targetDomain !== TARGET_DOMAIN) {
      throw new Error("execution target domain is outside the local fixture boundary");
    }

    const capturedAt = (context.now ?? new Date()).toISOString();
    const referenceId = `SYN-${sha256(stableStringify({
      commandId: context.command.commandId,
      planHash: context.plan.planHash,
      idempotencyKey: context.command.idempotencyKey
    })).slice("sha256:".length, "sha256:".length + 20).toUpperCase()}`;
    const withoutHash: Omit<ExecutionObservation, "payloadHash"> = {
      adapterId: ADAPTER_ID,
      commandId: context.command.commandId,
      opportunityId: context.command.opportunityId,
      status: "submitted",
      capturedAt,
      sourceDomain: TARGET_DOMAIN,
      targetDomain: TARGET_DOMAIN,
      referenceId,
      indicators: ["application successfully submitted"],
      attachmentCount: context.command.documentHashes.length,
      submittedAt: capturedAt
    };
    return { ...withoutHash, payloadHash: sha256(stableStringify(withoutHash)) };
  },

  async collect(attempt, observation): Promise<SubmissionObservationDraft> {
    if (observation.adapterId !== ADAPTER_ID || observation.status !== "submitted") {
      throw new Error("local fixture collector requires a submitted local fixture observation");
    }
    if (observation.opportunityId !== attempt.opportunityId) {
      throw new Error("local fixture observation is bound to a different opportunity");
    }
    if (!observation.referenceId) throw new Error("local fixture observation reference is required");
    return {
      collectorId: "career-ops-local-fixture-collector",
      collectorVersion: ADAPTER_VERSION,
      keyId: "KEY-CAREER-OPS-LOCAL-FIXTURE",
      attemptId: attempt.attemptId,
      actionIntentHash: attempt.actionIntentHash,
      opportunityId: attempt.opportunityId,
      packetHash: attempt.packetHash,
      adapterId: ADAPTER_ID,
      kind: "confirmation-page",
      capturedAt: observation.capturedAt,
      sourceDomain: observation.sourceDomain,
      sourcePointer: `proof:${observation.referenceId}`,
      indicators: [...observation.indicators],
      recipientDomain: null,
      attachmentCount: observation.attachmentCount,
      referenceId: observation.referenceId,
      sentAt: observation.submittedAt,
      payloadHash: observation.payloadHash
    };
  },

  async reconcile(context: ReconciliationContext): Promise<ReconciliationResult> {
    if (!context.observation) {
      return { status: "unresolved", reasons: ["no execution observation is available"], referenceId: null };
    }
    if (context.observation.commandId !== context.command.commandId) {
      return { status: "not-confirmed", reasons: ["observation is bound to a different command"], referenceId: null };
    }
    if (context.observation.status !== "submitted" || !context.observation.referenceId) {
      return { status: "not-confirmed", reasons: ["observation does not confirm submission"], referenceId: null };
    }
    return { status: "confirmed", reasons: [], referenceId: context.observation.referenceId };
  }
};
