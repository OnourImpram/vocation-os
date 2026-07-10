import { sha256, stableStringify } from "./hash.js";
import { assertSchema } from "./schema.js";

export const OPPORTUNITY_SOURCES = ["greenhouse", "lever", "ashby", "manual"] as const;
export const REMOTE_POLICIES = ["remote", "hybrid", "on-site", "unspecified"] as const;

export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];
export type RemotePolicy = (typeof REMOTE_POLICIES)[number];
export type ExtractionConfidence = "high" | "medium" | "low";

export interface OpportunityRecord {
  opportunityId: string;
  source: OpportunitySource;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl: string;
  applyUrl: string | null;
  company: string;
  roleTitle: string;
  locationText: string;
  remotePolicy: RemotePolicy;
  applicantLocationRequirements: string[];
  compensationText: string | null;
  descriptionText: string;
  descriptionHash: string;
  sourcePayloadHash: string;
  fingerprint: string;
  postedAt: string | null;
  capturedAt: string;
  extractionConfidence: ExtractionConfidence;
}

export interface OpportunityDraft {
  source: OpportunitySource;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl?: string | undefined;
  applyUrl?: string | null | undefined;
  company: string;
  roleTitle: string;
  locationText?: string | undefined;
  remotePolicy?: RemotePolicy | undefined;
  applicantLocationRequirements?: string[] | undefined;
  compensationText?: string | null | undefined;
  descriptionText: string;
  postedAt?: string | null | undefined;
  capturedAt?: string | undefined;
  extractionConfidence: ExtractionConfidence;
  sourcePayload: unknown;
}

export type IntakeGateOutcome = "pass" | "manual-review" | "reject";

export interface OpportunityIntakeGate {
  gate: string;
  outcome: IntakeGateOutcome;
  reason: string;
}

export interface OpportunityIntakePolicy {
  requiresRemote: boolean;
  requireExplicitApplicantLocation: boolean;
  candidateRegions: string[];
  maxAgeDays: number;
  minimumDescriptionCharacters: number;
  existingFingerprints: string[];
  evaluatedAt: string;
}

export interface OpportunityIntakeDecision {
  opportunityId: string;
  status: "accepted" | "manual_review" | "rejected";
  reasons: string[];
  gates: OpportunityIntakeGate[];
  evaluatedAt: string;
}

const TRACKING_PARAMETERS = new Set(["referrer", "lever-source"]);
const GLOBAL_LOCATION_MARKERS = ["anywhere", "global", "worldwide", "world"];

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

function safeIdToken(value: string): string {
  const token = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 48);
  return token || sha256(value).slice("sha256:".length, "sha256:".length + 12).toUpperCase();
}

export function opportunityIdFor(source: OpportunitySource, sourceId: string): string {
  return `OPP-${source.toUpperCase()}-${safeIdToken(sourceId)}`;
}

export function classifyRemotePolicy(explicit: RemotePolicy | undefined, locationText: string): RemotePolicy {
  if (explicit && explicit !== "unspecified") {
    return explicit;
  }
  const normalized = normalizeWhitespace(locationText).toLowerCase();
  if (/\bhybrid\b/.test(normalized)) {
    return "hybrid";
  }
  if (/\b(on[ -]?site|office based|in office)\b/.test(normalized)) {
    return "on-site";
  }
  if (/\b(remote|telecommute|distributed|work from home|anywhere)\b/.test(normalized)) {
    return "remote";
  }
  return "unspecified";
}

export function createOpportunityRecord(draft: OpportunityDraft): OpportunityRecord {
  const capturedAt = draft.capturedAt ?? new Date().toISOString();
  const sourceUrl = canonicalizeUrl(draft.sourceUrl);
  const canonicalUrl = canonicalizeUrl(draft.canonicalUrl ?? draft.sourceUrl);
  const applyUrl = draft.applyUrl ? canonicalizeUrl(draft.applyUrl) : null;
  const company = normalizeWhitespace(draft.company);
  const roleTitle = normalizeWhitespace(draft.roleTitle);
  const locationText = normalizeWhitespace(draft.locationText ?? "");
  const descriptionText = normalizeWhitespace(draft.descriptionText);
  const sourceId = normalizeWhitespace(draft.sourceId);
  const applicantLocationRequirements = [...new Set((draft.applicantLocationRequirements ?? []).map(normalizeWhitespace).filter(Boolean))].sort();
  const record: OpportunityRecord = {
    opportunityId: opportunityIdFor(draft.source, sourceId),
    source: draft.source,
    sourceId,
    sourceUrl,
    canonicalUrl,
    applyUrl,
    company,
    roleTitle,
    locationText,
    remotePolicy: classifyRemotePolicy(draft.remotePolicy, locationText),
    applicantLocationRequirements,
    compensationText: draft.compensationText ? normalizeWhitespace(draft.compensationText) : null,
    descriptionText,
    descriptionHash: sha256(descriptionText),
    sourcePayloadHash: sha256(stableStringify(draft.sourcePayload)),
    fingerprint: sha256(stableStringify({ source: draft.source, sourceId, canonicalUrl, company, roleTitle })),
    postedAt: draft.postedAt ?? null,
    capturedAt,
    extractionConfidence: draft.extractionConfidence
  };
  assertSchema("opportunity-record", record);
  return record;
}

function normalizeRegion(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function regionMatches(requirement: string, candidateRegions: string[]): boolean {
  const normalizedRequirement = normalizeRegion(requirement);
  if (GLOBAL_LOCATION_MARKERS.some((marker) => normalizedRequirement.includes(marker))) {
    return true;
  }
  return candidateRegions.some((candidate) => {
    const normalizedCandidate = normalizeRegion(candidate);
    if (!normalizedCandidate) {
      return false;
    }
    if (normalizedCandidate.length <= 3) {
      return new RegExp(`(^| )${normalizedCandidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(normalizedRequirement);
    }
    return normalizedRequirement === normalizedCandidate || normalizedRequirement.includes(normalizedCandidate);
  });
}

function gate(gateName: string, outcome: IntakeGateOutcome, reason: string): OpportunityIntakeGate {
  return { gate: gateName, outcome, reason };
}

export function evaluateOpportunityIntake(record: OpportunityRecord, policy: OpportunityIntakePolicy): OpportunityIntakeDecision {
  assertSchema("opportunity-record", record);
  const gates: OpportunityIntakeGate[] = [];

  gates.push(
    record.sourceUrl.startsWith("https://") && record.canonicalUrl.startsWith("https://") && (record.applyUrl === null || record.applyUrl.startsWith("https://"))
      ? gate("secure-source", "pass", "source and application URLs use HTTPS")
      : gate("secure-source", "reject", "source and application URLs must use HTTPS")
  );

  gates.push(record.applyUrl ? gate("apply-route", "pass", "application route is present") : gate("apply-route", "reject", "application route is missing"));

  gates.push(
    policy.existingFingerprints.includes(record.fingerprint)
      ? gate("duplicate", "reject", "opportunity fingerprint already exists")
      : gate("duplicate", "pass", "opportunity fingerprint is new")
  );

  if (policy.requiresRemote) {
    if (record.remotePolicy === "hybrid" || record.remotePolicy === "on-site") {
      gates.push(gate("remote-policy", "reject", `role is ${record.remotePolicy}`));
    } else if (record.remotePolicy === "unspecified") {
      gates.push(gate("remote-policy", "manual-review", "remote status is not explicit"));
    } else {
      gates.push(gate("remote-policy", "pass", "role is explicitly remote"));
    }
  } else {
    gates.push(gate("remote-policy", "pass", "policy does not require remote work"));
  }

  if (record.applicantLocationRequirements.length === 0) {
    gates.push(
      policy.requireExplicitApplicantLocation
        ? gate("applicant-location", "manual-review", "remote eligibility geography is not explicit")
        : gate("applicant-location", "pass", "explicit applicant geography is not required by policy")
    );
  } else if (record.applicantLocationRequirements.some((requirement) => regionMatches(requirement, policy.candidateRegions))) {
    gates.push(gate("applicant-location", "pass", "applicant geography matches the candidate region set"));
  } else {
    gates.push(gate("applicant-location", "reject", "applicant geography does not match the candidate region set"));
  }

  if (record.postedAt === null) {
    gates.push(gate("freshness", "manual-review", "posting date is unavailable"));
  } else {
    const postedAt = Date.parse(record.postedAt);
    const evaluatedAt = Date.parse(policy.evaluatedAt);
    const ageDays = (evaluatedAt - postedAt) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < -2) {
      gates.push(gate("freshness", "manual-review", "posting date is invalid or unexpectedly in the future"));
    } else if (ageDays > policy.maxAgeDays) {
      gates.push(gate("freshness", "reject", `posting is older than ${policy.maxAgeDays} days`));
    } else {
      gates.push(gate("freshness", "pass", "posting is within the configured freshness window"));
    }
  }

  gates.push(
    record.descriptionText.length >= policy.minimumDescriptionCharacters
      ? gate("description-quality", "pass", "description is substantive enough for evaluation")
      : gate("description-quality", "reject", "description is too thin for evidence grounded evaluation")
  );

  const rejected = gates.some((entry) => entry.outcome === "reject");
  const needsReview = gates.some((entry) => entry.outcome === "manual-review");
  const decision: OpportunityIntakeDecision = {
    opportunityId: record.opportunityId,
    status: rejected ? "rejected" : needsReview ? "manual_review" : "accepted",
    reasons: gates.filter((entry) => entry.outcome !== "pass").map((entry) => entry.reason),
    gates,
    evaluatedAt: policy.evaluatedAt
  };
  assertSchema("opportunity-intake", decision);
  return decision;
}
