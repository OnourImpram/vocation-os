import { sha256, stableStringify } from "../hash.js";
import { canonicalizeUrl, normalizeWhitespace } from "../opportunity.js";
import { assertSchema } from "../schema.js";

export const VERIFICATION_SOURCE_KINDS = ["primary", "independent", "pre-action"] as const;
export const VERIFICATION_OBSERVED_STATUSES = ["live", "closed", "stale", "unverifiable"] as const;
export const VERIFICATION_BUNDLE_STATUSES = ["incomplete", "verified", "expired", "conflicted", "rejected"] as const;

export type VerificationSourceKind = (typeof VERIFICATION_SOURCE_KINDS)[number];
export type VerificationObservedStatus = (typeof VERIFICATION_OBSERVED_STATUSES)[number];
export type VerificationBundleStatus = (typeof VERIFICATION_BUNDLE_STATUSES)[number];
export type VerificationExtractionConfidence = "high" | "medium" | "low";

export interface VerificationObservation {
  observationId: string;
  opportunityId: string;
  sourceKind: VerificationSourceKind;
  sourceUrl: string;
  sourceDomain: string;
  employer: string;
  roleTitle: string;
  requisitionId: string | null;
  locationText: string;
  applyUrl: string | null;
  postedAt: string | null;
  deadlineAt: string | null;
  observedStatus: VerificationObservedStatus;
  capturedAt: string;
  payloadHash: string;
  extractionConfidence: VerificationExtractionConfidence;
}

export interface VerificationObservationDraft {
  opportunityId: string;
  sourceKind: VerificationSourceKind;
  sourceUrl: string;
  employer: string;
  roleTitle: string;
  requisitionId: string | null;
  locationText: string;
  applyUrl: string | null;
  postedAt: string | null;
  deadlineAt: string | null;
  observedStatus: VerificationObservedStatus;
  capturedAt: string;
  extractionConfidence: VerificationExtractionConfidence;
  sourcePayload: unknown;
}

export interface VerificationPolicy {
  maximumPreActionAgeSeconds: number;
  bundleLifetimeSeconds: number;
}

export interface OpportunityVerificationBundle {
  opportunityId: string;
  status: VerificationBundleStatus;
  primaryObservationId: string | null;
  independentObservationId: string | null;
  preActionObservationId: string | null;
  reasons: string[];
  evaluatedAt: string;
  expiresAt: string;
  bundleHash: string;
}

export interface EvaluateVerificationBundleInput {
  opportunityId: string;
  primary: VerificationObservation | null;
  independent: VerificationObservation | null;
  preAction: VerificationObservation | null;
  policy: VerificationPolicy;
  evaluatedAt: string;
}

function requireHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("verification source URLs must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("verification URLs must not contain embedded credentials");
  }
  return canonicalizeUrl(value);
}

function optionalTimestamp(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid date-time`);
  return new Date(value).toISOString();
}

function requiredTimestamp(value: string, label: string): string {
  const normalized = optionalTimestamp(value, label);
  if (normalized === null) throw new Error(`${label} is required`);
  return normalized;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function observationIdFor(value: Omit<VerificationObservation, "observationId">): string {
  const digest = sha256(stableStringify(value)).slice("sha256:".length, "sha256:".length + 20).toUpperCase();
  return `OBS-${digest}`;
}

export function createVerificationObservation(draft: VerificationObservationDraft): VerificationObservation {
  const sourceUrl = requireHttpsUrl(draft.sourceUrl, "verification source URL");
  const applyUrl = draft.applyUrl ? requireHttpsUrl(draft.applyUrl, "verification apply URL") : null;
  const capturedAt = requiredTimestamp(draft.capturedAt, "verification capture time");
  const sourceDomain = new URL(sourceUrl).hostname.toLowerCase();
  const base: Omit<VerificationObservation, "observationId"> = {
    opportunityId: normalizeWhitespace(draft.opportunityId),
    sourceKind: draft.sourceKind,
    sourceUrl,
    sourceDomain,
    employer: normalizeWhitespace(draft.employer),
    roleTitle: normalizeWhitespace(draft.roleTitle),
    requisitionId: draft.requisitionId ? normalizeWhitespace(draft.requisitionId) : null,
    locationText: normalizeWhitespace(draft.locationText),
    applyUrl,
    postedAt: optionalTimestamp(draft.postedAt, "verification posting time"),
    deadlineAt: optionalTimestamp(draft.deadlineAt, "verification deadline"),
    observedStatus: draft.observedStatus,
    capturedAt,
    payloadHash: sha256(stableStringify(draft.sourcePayload)),
    extractionConfidence: draft.extractionConfidence
  };
  const observation: VerificationObservation = {
    observationId: observationIdFor(base),
    ...base
  };
  assertSchema("verification-observation", observation);
  return observation;
}

function normalizedIdentity(value: string): string {
  return normalizeWhitespace(value).normalize("NFKC").toLowerCase();
}

function canonicalSourceFamily(observation: VerificationObservation): string {
  const url = new URL(observation.sourceUrl);
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "") || "/"}`;
}

export function verificationSourcesAreIndependent(
  primary: VerificationObservation,
  independent: VerificationObservation
): boolean {
  if (primary.observationId === independent.observationId) return false;
  return canonicalSourceFamily(primary) !== canonicalSourceFamily(independent);
}

function canonicalBundleForHash(bundle: OpportunityVerificationBundle): Omit<OpportunityVerificationBundle, "bundleHash"> {
  const { bundleHash: _bundleHash, ...rest } = bundle;
  return rest;
}

function makeBundle(
  input: EvaluateVerificationBundleInput,
  status: VerificationBundleStatus,
  reasons: string[],
  expiresAt: string
): OpportunityVerificationBundle {
  const withoutHash: Omit<OpportunityVerificationBundle, "bundleHash"> = {
    opportunityId: input.opportunityId,
    status,
    primaryObservationId: input.primary?.observationId ?? null,
    independentObservationId: input.independent?.observationId ?? null,
    preActionObservationId: input.preAction?.observationId ?? null,
    reasons: [...new Set(reasons)],
    evaluatedAt: requiredTimestamp(input.evaluatedAt, "verification evaluation time"),
    expiresAt
  };
  const bundle: OpportunityVerificationBundle = {
    ...withoutHash,
    bundleHash: sha256(stableStringify(withoutHash))
  };
  assertSchema("opportunity-verification-bundle", bundle);
  return bundle;
}

export function evaluateVerificationBundle(input: EvaluateVerificationBundleInput): OpportunityVerificationBundle {
  const maximumPreActionAgeSeconds = boundedPositiveInteger(
    input.policy.maximumPreActionAgeSeconds,
    "maximum pre-action age"
  );
  const bundleLifetimeSeconds = boundedPositiveInteger(input.policy.bundleLifetimeSeconds, "bundle lifetime");
  const evaluatedAt = requiredTimestamp(input.evaluatedAt, "verification evaluation time");
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const primaryCapturedAtMs = input.primary ? Date.parse(input.primary.capturedAt) : evaluatedAtMs;
  const expiresAt = new Date(primaryCapturedAtMs + bundleLifetimeSeconds * 1000).toISOString();

  const missing: string[] = [];
  if (!input.primary) missing.push("primary observation is missing");
  if (!input.independent) missing.push("independent observation is missing");
  if (!input.preAction) missing.push("pre-action observation is missing");
  if (missing.length > 0) return makeBundle(input, "incomplete", missing, expiresAt);

  const primary = input.primary!;
  const independent = input.independent!;
  const preAction = input.preAction!;

  const opportunityIds = new Set([
    input.opportunityId,
    primary.opportunityId,
    independent.opportunityId,
    preAction.opportunityId
  ]);
  if (opportunityIds.size !== 1) {
    return makeBundle(input, "conflicted", ["opportunity id conflicts across verification observations"], expiresAt);
  }

  if (!verificationSourcesAreIndependent(primary, independent)) {
    return makeBundle(input, "rejected", ["independent observation is not source-independent"], expiresAt);
  }

  const notLive: string[] = [];
  if (primary.observedStatus !== "live") notLive.push("primary observation is not live");
  if (independent.observedStatus !== "live") notLive.push("independent observation is not live");
  if (preAction.observedStatus !== "live") notLive.push("pre-action observation is not live");
  if (notLive.length > 0) return makeBundle(input, "rejected", notLive, expiresAt);

  const conflicts: string[] = [];
  const employers = new Set([primary.employer, independent.employer, preAction.employer].map(normalizedIdentity));
  if (employers.size !== 1) conflicts.push("employer conflicts across verification observations");
  const roles = new Set([primary.roleTitle, independent.roleTitle, preAction.roleTitle].map(normalizedIdentity));
  if (roles.size !== 1) conflicts.push("role title conflicts across verification observations");
  const requisitions = [primary.requisitionId, independent.requisitionId, preAction.requisitionId]
    .filter((value): value is string => value !== null)
    .map(normalizedIdentity);
  if (new Set(requisitions).size > 1) conflicts.push("requisition id conflicts across verification observations");
  if (conflicts.length > 0) return makeBundle(input, "conflicted", conflicts, expiresAt);

  if (evaluatedAtMs > Date.parse(expiresAt)) {
    return makeBundle(input, "expired", ["verification bundle lifetime has expired"], expiresAt);
  }

  const preActionCapturedAtMs = Date.parse(preAction.capturedAt);
  const preActionAgeSeconds = (evaluatedAtMs - preActionCapturedAtMs) / 1000;
  if (!Number.isFinite(preActionAgeSeconds) || preActionAgeSeconds < -300) {
    return makeBundle(input, "rejected", ["pre-action observation time is invalid"], expiresAt);
  }
  if (preActionAgeSeconds > maximumPreActionAgeSeconds) {
    return makeBundle(
      input,
      "expired",
      ["pre-action observation is older than the allowed execution window"],
      expiresAt
    );
  }

  return makeBundle(input, "verified", [], expiresAt);
}

export function computeVerificationBundleHash(bundle: OpportunityVerificationBundle): string {
  return sha256(stableStringify(canonicalBundleForHash(bundle)));
}
