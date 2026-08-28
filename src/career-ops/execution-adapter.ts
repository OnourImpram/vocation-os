import type { ApplicationAttempt } from "../application-lifecycle.js";
import { assertSchema } from "../schema.js";
import type { SubmissionObservationDraft, SubmissionProofKind } from "../submission-proof.js";
import type { AdapterAuthorizationContext } from "./adapter-authorization.js";
import type { CareerActionType } from "./execution-grant.js";
import type { ExecutionObservation } from "./execution-observation.js";
import type { LegitimacyTier } from "./legitimacy.js";
import type { OutboxCommand } from "./outbox.js";
import type { VerificationBundleStatus } from "./verification.js";
import { careerOpsLocalFixtureAdapter } from "./local-fixture-adapter.js";

export type { AdapterAuthorizationContext } from "./adapter-authorization.js";
export type { ExecutionObservation } from "./execution-observation.js";

export const EXECUTION_ADAPTER_MATURITIES = ["synthetic", "experimental", "stable"] as const;
export const EXECUTION_PROFILE_SCOPES = ["synthetic", "local-private"] as const;

export type ExecutionAdapterMaturity = (typeof EXECUTION_ADAPTER_MATURITIES)[number];
export type ExecutionProfileScope = (typeof EXECUTION_PROFILE_SCOPES)[number];

export interface ExecutionAdapterManifest {
  adapterId: string;
  version: string;
  maturity: ExecutionAdapterMaturity;
  supportedDomains: string[];
  supportedProfileScopes: ExecutionProfileScope[];
  supportedActionTypes: CareerActionType[];
  supportedFields: string[];
  forbiddenFields: string[];
  proofKinds: SubmissionProofKind[];
  requiresBrowser: boolean;
  requiresLogin: boolean;
  lastVerifiedAt: string;
  recipeHash: string;
}

export interface AdapterInspectContext {
  opportunityId: string;
  profileScope: ExecutionProfileScope;
  targetDomain: string;
}

export interface AdapterInspection {
  allowed: boolean;
  blockedBy?: string;
  reasons: string[];
}

export interface AdapterPlanContext {
  command: OutboxCommand;
  profileScope: ExecutionProfileScope;
  verificationStatus: VerificationBundleStatus;
  legitimacyTier: LegitimacyTier;
  requestedFields: string[];
  authorization: AdapterAuthorizationContext;
}

export interface AdapterExecutionPlan {
  planId: string;
  adapterId: string;
  commandId: string;
  opportunityId: string;
  actionType: CareerActionType;
  targetDomain: string;
  profileScope: ExecutionProfileScope;
  verificationStatus: VerificationBundleStatus;
  legitimacyTier: LegitimacyTier;
  requestedFields: string[];
  executionGrantId: string;
  grantSignatureHash: string;
  opportunityType: string;
  fitScore: number;
  plannedAt: string;
  planHash: string;
}

export interface AdapterValidationResult {
  valid: boolean;
  reasons: string[];
}

export interface AdapterPreview {
  planId: string;
  planHash: string;
  adapterId: string;
  actionType: CareerActionType;
  targetDomain: string;
  requestedFields: string[];
  warnings: string[];
}

export interface AdapterExecuteContext {
  command: OutboxCommand;
  plan: AdapterExecutionPlan;
  authorization: AdapterAuthorizationContext;
  now?: Date;
}

export interface ReconciliationContext {
  command: OutboxCommand;
  planHash: string;
  observation: ExecutionObservation | null;
}

export interface ReconciliationResult {
  status: "confirmed" | "not-confirmed" | "unresolved";
  reasons: string[];
  referenceId: string | null;
}

export interface ExecutionAdapter {
  manifest(): ExecutionAdapterManifest;
  inspect(context: AdapterInspectContext): Promise<AdapterInspection>;
  plan(context: AdapterPlanContext): Promise<AdapterExecutionPlan>;
  validate(plan: AdapterExecutionPlan): Promise<AdapterValidationResult>;
  preview(plan: AdapterExecutionPlan): Promise<AdapterPreview>;
  execute(context: AdapterExecuteContext): Promise<ExecutionObservation>;
  collect(attempt: ApplicationAttempt, observation: ExecutionObservation): Promise<SubmissionObservationDraft>;
  reconcile(context: ReconciliationContext): Promise<ReconciliationResult>;
}

export function validateExecutionAdapterManifest(manifest: ExecutionAdapterManifest): void {
  assertSchema("execution-adapter-manifest", manifest);
}

const SHIPPED_ADAPTERS = new Map<string, ExecutionAdapter>([
  [careerOpsLocalFixtureAdapter.manifest().adapterId, careerOpsLocalFixtureAdapter]
]);

for (const adapter of SHIPPED_ADAPTERS.values()) {
  validateExecutionAdapterManifest(adapter.manifest());
}

export function listShippedCareerExecutionAdapters(): string[] {
  return [...SHIPPED_ADAPTERS.keys()].sort();
}

export function getShippedCareerExecutionAdapter(adapterId: string): ExecutionAdapter | null {
  return SHIPPED_ADAPTERS.get(adapterId.trim().toLowerCase()) ?? null;
}
