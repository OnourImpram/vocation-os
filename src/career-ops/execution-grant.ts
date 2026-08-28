import { createPublicKey, sign, verify, type KeyLike } from "node:crypto";
import { sha256, stableStringify } from "../hash.js";
import { assertSchema } from "../schema.js";
import type { TrustedApprover } from "../approval.js";
import type { LegitimacyTier } from "./legitimacy.js";

export const CAREER_ACTION_TYPES = [
  "send-application-email",
  "send-outreach-email",
  "send-follow-up-email",
  "submit-ats-application"
] as const;

export type CareerActionType = (typeof CAREER_ACTION_TYPES)[number];

export interface ExecutionGrant {
  grantId: string;
  approvedBy: string;
  keyId: string;
  allowedAdapters: string[];
  allowedEmployerDomains: string[];
  allowedOpportunityTypes: string[];
  allowedActionTypes: CareerActionType[];
  allowedFields: string[];
  forbiddenFields: string[];
  minimumFitScore: number;
  allowedLegitimacyTiers: LegitimacyTier[];
  maxActions: number;
  maxActionsPerDay: number;
  validFrom: string;
  expiresAt: string;
  approvalTextHash: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export interface ExecutionGrantDraft {
  grantId: string;
  approvedBy: string;
  keyId: string;
  allowedAdapters: string[];
  allowedEmployerDomains: string[];
  allowedOpportunityTypes: string[];
  allowedActionTypes: CareerActionType[];
  allowedFields: string[];
  forbiddenFields: string[];
  minimumFitScore: number;
  allowedLegitimacyTiers: LegitimacyTier[];
  maxActions: number;
  maxActionsPerDay: number;
  validFrom: string;
  expiresAt: string;
  approvalText: string;
}

export interface ExecutionGrantExpectation {
  adapterId: string;
  employerDomain: string;
  opportunityType: string;
  actionType: CareerActionType;
  requestedFields: string[];
  fitScore: number;
  legitimacyTier: LegitimacyTier;
  totalConfirmedActions: number;
  confirmedActionsToday: number;
  evaluatedAt: string;
}

export interface ExecutionGrantDecision {
  allowed: boolean;
  blockedBy?: string;
  reasons: string[];
  grantId: string;
}

type UnsignedExecutionGrant = Omit<ExecutionGrant, "signatureAlgorithm" | "signature">;

const ADAPTER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPPORTUNITY_TYPE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z0-9.-]+$/;

function normalizeToken(value: string, label: string, pattern: RegExp): string {
  const normalized = value.trim().toLowerCase();
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizeList(values: string[], label: string, pattern: RegExp): string[] {
  const normalized = [...new Set(values.map((value) => normalizeToken(value, label, pattern)))].sort();
  if (normalized.length === 0) throw new Error(`${label} must contain at least one value`);
  return normalized;
}

function normalizeDateTime(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date-time`);
  return new Date(parsed).toISOString();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function normalizeFitScore(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 5) throw new Error("minimum fit score must be between 1 and 5");
  return value;
}

function unsignedGrant(grant: ExecutionGrant): UnsignedExecutionGrant {
  const { signatureAlgorithm: _algorithm, signature: _signature, ...unsigned } = grant;
  return unsigned;
}

function blocked(grantId: string, blockedBy: string, reasons: string[]): ExecutionGrantDecision {
  return { allowed: false, blockedBy, reasons, grantId };
}

export function createExecutionGrant(draft: ExecutionGrantDraft, privateKey: KeyLike): ExecutionGrant {
  const validFrom = normalizeDateTime(draft.validFrom, "execution grant validFrom");
  const expiresAt = normalizeDateTime(draft.expiresAt, "execution grant expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(validFrom)) throw new Error("execution grant must expire after it becomes valid");
  if (Date.parse(expiresAt) - Date.parse(validFrom) > 31 * 86_400_000) {
    throw new Error("execution grant validity must not exceed 31 days");
  }

  const approvalText = draft.approvalText.trim();
  if (!approvalText) throw new Error("execution grant approval text is required");
  if (approvalText.length > 10_000) throw new Error("execution grant approval text must not exceed 10000 characters");

  const allowedFields = normalizeList(draft.allowedFields, "allowed field", FIELD_PATTERN);
  const forbiddenFields = normalizeList(draft.forbiddenFields, "forbidden field", FIELD_PATTERN);
  const overlap = allowedFields.filter((field) => forbiddenFields.includes(field));
  if (overlap.length > 0) throw new Error(`execution grant field appears in allowed and forbidden scope: ${overlap.join(", ")}`);

  const maxActions = positiveInteger(draft.maxActions, "maximum actions");
  const maxActionsPerDay = positiveInteger(draft.maxActionsPerDay, "maximum actions per day");
  if (maxActionsPerDay > maxActions) throw new Error("daily action limit must not exceed the total action limit");

  const unsigned: UnsignedExecutionGrant = {
    grantId: draft.grantId.trim(),
    approvedBy: draft.approvedBy.trim(),
    keyId: draft.keyId.trim(),
    allowedAdapters: normalizeList(draft.allowedAdapters, "adapter id", ADAPTER_ID_PATTERN),
    allowedEmployerDomains: normalizeList(draft.allowedEmployerDomains, "employer domain", DOMAIN_PATTERN),
    allowedOpportunityTypes: normalizeList(draft.allowedOpportunityTypes, "opportunity type", OPPORTUNITY_TYPE_PATTERN),
    allowedActionTypes: [...new Set(draft.allowedActionTypes)].sort(),
    allowedFields,
    forbiddenFields,
    minimumFitScore: normalizeFitScore(draft.minimumFitScore),
    allowedLegitimacyTiers: [...new Set(draft.allowedLegitimacyTiers)].sort(),
    maxActions,
    maxActionsPerDay,
    validFrom,
    expiresAt,
    approvalTextHash: sha256(approvalText)
  };
  if (!unsigned.grantId || !unsigned.approvedBy || !unsigned.keyId) throw new Error("execution grant identity fields are required");
  if (unsigned.allowedActionTypes.length === 0) throw new Error("execution grant must allow at least one action type");
  if (unsigned.allowedLegitimacyTiers.length === 0) throw new Error("execution grant must allow at least one legitimacy tier");

  const signature = sign(null, Buffer.from(stableStringify(unsigned), "utf8"), privateKey).toString("base64url");
  const grant: ExecutionGrant = {
    ...unsigned,
    signatureAlgorithm: "Ed25519",
    signature
  };
  assertSchema("execution-grant", grant);
  return grant;
}

function signatureIsValid(grant: ExecutionGrant, trustedApprover: TrustedApprover): boolean {
  try {
    return verify(
      null,
      Buffer.from(stableStringify(unsignedGrant(grant)), "utf8"),
      createPublicKey(trustedApprover.publicKeyPem),
      Buffer.from(grant.signature, "base64url")
    );
  } catch {
    return false;
  }
}

function countIsValid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateExecutionGrant(
  grant: ExecutionGrant,
  trustedApprovers: readonly TrustedApprover[],
  expectation: ExecutionGrantExpectation
): ExecutionGrantDecision {
  try {
    assertSchema("execution-grant", grant);
  } catch (error) {
    return blocked(grant.grantId, "execution-grant-schema-invalid", [error instanceof Error ? error.message : String(error)]);
  }

  const trustedApprover = trustedApprovers.find(
    (candidate) => candidate.approvedBy === grant.approvedBy && candidate.keyId === grant.keyId
  );
  if (!trustedApprover) {
    return blocked(grant.grantId, "execution-grant-approver-untrusted", ["execution grant signer is not trusted"]);
  }
  if (!signatureIsValid(grant, trustedApprover)) {
    return blocked(grant.grantId, "execution-grant-signature-invalid", ["execution grant signature is invalid"]);
  }

  const evaluatedAt = Date.parse(expectation.evaluatedAt);
  if (!Number.isFinite(evaluatedAt)) {
    return blocked(grant.grantId, "execution-grant-evaluation-time-invalid", ["evaluation time is invalid"]);
  }
  if (!Number.isFinite(expectation.fitScore) || expectation.fitScore < 1 || expectation.fitScore > 5) {
    return blocked(grant.grantId, "execution-grant-fit-score-invalid", ["fit score must be between 1 and 5"]);
  }
  if (
    !countIsValid(expectation.totalConfirmedActions)
    || !countIsValid(expectation.confirmedActionsToday)
    || expectation.confirmedActionsToday > expectation.totalConfirmedActions
  ) {
    return blocked(
      grant.grantId,
      "execution-grant-usage-invalid",
      ["execution grant usage counts must be non-negative, internally consistent integers"]
    );
  }

  let adapterId: string;
  let employerDomain: string;
  let opportunityType: string;
  let requestedFields: string[];
  try {
    adapterId = normalizeToken(expectation.adapterId, "adapter id", ADAPTER_ID_PATTERN);
    employerDomain = normalizeToken(expectation.employerDomain, "employer domain", DOMAIN_PATTERN);
    opportunityType = normalizeToken(expectation.opportunityType, "opportunity type", OPPORTUNITY_TYPE_PATTERN);
    if (!CAREER_ACTION_TYPES.includes(expectation.actionType)) throw new Error("action type is invalid");
    requestedFields = [...new Set(
      expectation.requestedFields.map((field) => normalizeToken(field, "requested field", FIELD_PATTERN))
    )].sort();
  } catch (error) {
    return blocked(
      grant.grantId,
      "execution-grant-expectation-invalid",
      [error instanceof Error ? error.message : String(error)]
    );
  }

  if (evaluatedAt < Date.parse(grant.validFrom)) {
    return blocked(grant.grantId, "execution-grant-not-yet-valid", ["execution grant is not yet valid"]);
  }
  if (evaluatedAt >= Date.parse(grant.expiresAt)) {
    return blocked(grant.grantId, "execution-grant-expired", ["execution grant has expired"]);
  }

  if (!grant.allowedAdapters.includes(adapterId)) {
    return blocked(grant.grantId, "adapter-not-granted", [`adapter ${adapterId} is outside the grant scope`]);
  }
  if (!grant.allowedEmployerDomains.includes(employerDomain)) {
    return blocked(grant.grantId, "employer-domain-not-granted", [`employer domain ${employerDomain} is outside the grant scope`]);
  }
  if (!grant.allowedOpportunityTypes.includes(opportunityType)) {
    return blocked(grant.grantId, "opportunity-type-not-granted", [`opportunity type ${opportunityType} is outside the grant scope`]);
  }
  if (!grant.allowedActionTypes.includes(expectation.actionType)) {
    return blocked(grant.grantId, "action-type-not-granted", [`action type ${expectation.actionType} is outside the grant scope`]);
  }

  const forbidden = requestedFields.filter((field) => grant.forbiddenFields.includes(field));
  if (forbidden.length > 0) {
    return blocked(grant.grantId, "forbidden-field-requested", forbidden.map((field) => `field ${field} is forbidden`));
  }
  const outsideAllowed = requestedFields.filter((field) => !grant.allowedFields.includes(field));
  if (outsideAllowed.length > 0) {
    return blocked(grant.grantId, "field-not-granted", outsideAllowed.map((field) => `field ${field} is outside the grant scope`));
  }

  if (expectation.fitScore < grant.minimumFitScore) {
    return blocked(
      grant.grantId,
      "fit-score-below-grant-threshold",
      [`fit score ${expectation.fitScore} is below ${grant.minimumFitScore}`]
    );
  }
  if (!grant.allowedLegitimacyTiers.includes(expectation.legitimacyTier)) {
    return blocked(
      grant.grantId,
      "legitimacy-tier-not-granted",
      [`legitimacy tier ${expectation.legitimacyTier} is outside the grant scope`]
    );
  }

  if (expectation.totalConfirmedActions >= grant.maxActions) {
    return blocked(grant.grantId, "execution-grant-total-limit-exhausted", ["execution grant total action limit is exhausted"]);
  }
  if (expectation.confirmedActionsToday >= grant.maxActionsPerDay) {
    return blocked(grant.grantId, "execution-grant-daily-limit-exhausted", ["execution grant daily action limit is exhausted"]);
  }

  return { allowed: true, reasons: [], grantId: grant.grantId };
}
