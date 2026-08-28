import { sha256, stableStringify } from "../hash.js";
import type { SubmissionObservationDraft } from "../submission-proof.js";
import { evaluateAdapterAuthorization } from "./adapter-authorization.js";
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
  ReconciliationContext,
  ReconciliationResult
} from "./execution-adapter.js";
import {
  createExecutionObservation,
  evaluateExecutionObservationBinding,
  evaluateExecutionObservationIntegrity
} from "./execution-observation.js";

const ADAPTER_ID = "career-ops-local-fixture";
const ADAPTER_VERSION = "0.7.0-alpha.1";
const COLLECTOR_ID = "COL-CAREER-OPS-LOCAL-FIXTURE";
const COLLECTOR_VERSION = "0.7.0";
const COLLECTOR_KEY_ID = "KEY-CAREER-OPS-LOCAL-FIXTURE";
const TARGET_DOMAIN = "synthetic.example";
const SUPPORTED_FIELDS = ["cv", "email", "name"] as const;
const FORBIDDEN_FIELDS = ["identity-document", "payment", "protected-traits"] as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPPORTUNITY_TYPE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function authorizationError(blockedBy: string | undefined, reasons: string[]): Error {
  const code = blockedBy ?? "adapter-authorization-denied";
  return new Error(`${code}: ${reasons.join(", ")}`);
}

function actionTime(now: Date | undefined, label: string): Date {
  const resolved = now ?? new Date();
  if (!Number.isFinite(resolved.getTime())) throw new Error(`${label} is invalid`);
  return resolved;
}

function validatePlanSynchronously(plan: AdapterExecutionPlan): AdapterValidationResult {
  const reasons: string[] = [];
  if (plan.adapterId !== ADAPTER_ID) reasons.push("plan adapter does not match the local fixture adapter");
  if (plan.targetDomain !== TARGET_DOMAIN) reasons.push("plan target domain is not supported");
  if (plan.profileScope !== "synthetic") reasons.push("plan profile scope is not synthetic");
  if (plan.verificationStatus !== "verified") reasons.push("plan verification is not current");
  if (plan.legitimacyTier !== "green") reasons.push("plan legitimacy tier is not green");
  if (plan.actionType !== "submit-ats-application") reasons.push("plan action type is not supported");
  if (!plan.executionGrantId.startsWith("GRANT-")) reasons.push("plan execution grant id is invalid");
  if (!SHA256_PATTERN.test(plan.grantSignatureHash)) reasons.push("plan grant signature hash is invalid");
  if (!OPPORTUNITY_TYPE_PATTERN.test(plan.opportunityType)) reasons.push("plan opportunity type is invalid");
  if (!Number.isFinite(plan.fitScore) || plan.fitScore < 1 || plan.fitScore > 5) reasons.push("plan fit score is invalid");
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
    const planningTime = actionTime(context.now, "adapter planning time");
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

    const authorization = evaluateAdapterAuthorization({
      authorization: context.authorization,
      command: context.command,
      requestedFields,
      legitimacyTier: context.legitimacyTier,
      evaluatedAt: planningTime
    });
    if (!authorization.allowed) throw authorizationError(authorization.blockedBy, authorization.reasons);

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
      executionGrantId: context.authorization.grant.grantId,
      grantSignatureHash: authorization.grantSignatureHash,
      opportunityType: context.authorization.expectation.opportunityType,
      fitScore: context.authorization.expectation.fitScore,
      plannedAt: planningTime.toISOString()
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

  async execute(context: AdapterExecuteContext) {
    const executionTime = actionTime(context.now, "adapter execution time");
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
    if (context.command.executionGrantId !== context.plan.executionGrantId) {
      throw new Error("execution plan grant does not match the Outbox command");
    }

    const authorization = evaluateAdapterAuthorization({
      authorization: context.authorization,
      command: context.command,
      requestedFields: context.plan.requestedFields,
      legitimacyTier: context.plan.legitimacyTier,
      evaluatedAt: executionTime,
      expectedOpportunityType: context.plan.opportunityType,
      expectedFitScore: context.plan.fitScore,
      expectedGrantSignatureHash: context.plan.grantSignatureHash
    });
    if (!authorization.allowed) throw authorizationError(authorization.blockedBy, authorization.reasons);

    const capturedAt = executionTime.toISOString();
    const referenceId = `SYN-${sha256(stableStringify({
      commandId: context.command.commandId,
      planHash: context.plan.planHash,
      idempotencyKey: context.command.idempotencyKey
    })).slice("sha256:".length, "sha256:".length + 20).toUpperCase()}`;
    return createExecutionObservation({
      command: context.command,
      planHash: context.plan.planHash,
      status: "submitted",
      capturedAt,
      sourceDomain: TARGET_DOMAIN,
      targetDomain: TARGET_DOMAIN,
      referenceId,
      indicators: ["application successfully submitted"],
      attachmentCount: context.command.documentHashes.length,
      submittedAt: capturedAt
    });
  },

  async collect(attempt, observation): Promise<SubmissionObservationDraft> {
    const integrity = evaluateExecutionObservationIntegrity(observation);
    if (!integrity.valid) {
      throw new Error(`execution observation integrity failed: ${integrity.reasons.join(", ")}`);
    }
    if (observation.adapterId !== ADAPTER_ID || observation.status !== "submitted") {
      throw new Error("local fixture collector requires a submitted local fixture observation");
    }
    if (observation.sourceDomain !== TARGET_DOMAIN || observation.targetDomain !== TARGET_DOMAIN) {
      throw new Error("local fixture observation is outside the synthetic domain boundary");
    }
    if (observation.opportunityId !== attempt.opportunityId) {
      throw new Error("local fixture observation is bound to a different opportunity");
    }
    if (observation.attemptId !== attempt.attemptId) {
      throw new Error("local fixture observation is bound to a different application attempt");
    }
    if (observation.actionIntentHash !== attempt.actionIntentHash) {
      throw new Error("local fixture observation action intent does not match the application attempt");
    }
    if (observation.packetHash !== attempt.packetHash) {
      throw new Error("local fixture observation packet does not match the application attempt");
    }
    if (!observation.referenceId) throw new Error("local fixture observation reference is required");
    return {
      collectorId: COLLECTOR_ID,
      collectorVersion: COLLECTOR_VERSION,
      keyId: COLLECTOR_KEY_ID,
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
    const binding = evaluateExecutionObservationBinding(context.observation, context.command, context.planHash);
    if (!binding.valid) {
      return { status: "not-confirmed", reasons: binding.reasons, referenceId: null };
    }
    if (context.observation.status !== "submitted" || !context.observation.referenceId) {
      return { status: "not-confirmed", reasons: ["observation does not confirm submission"], referenceId: null };
    }
    return { status: "confirmed", reasons: [], referenceId: context.observation.referenceId };
  }
};
