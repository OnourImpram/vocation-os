import { sha256, stableStringify } from "../hash.js";
import { assertSchema } from "../schema.js";
import type { OpportunityVerificationBundle, VerificationExtractionConfidence } from "./verification.js";

export const LEGITIMACY_TIERS = ["green", "yellow", "red"] as const;
export const LEGITIMACY_SIGNAL_SEVERITIES = ["info", "warning", "blocking"] as const;

export type LegitimacyTier = (typeof LEGITIMACY_TIERS)[number];
export type LegitimacySignalSeverity = (typeof LEGITIMACY_SIGNAL_SEVERITIES)[number];

export interface LegitimacySignal {
  code: string;
  severity: LegitimacySignalSeverity;
  evidence: string;
}

export interface LegitimacyAssessment {
  opportunityId: string;
  tier: LegitimacyTier;
  signals: LegitimacySignal[];
  assessedAt: string;
  assessmentHash: string;
}

export interface LegitimacyObservations {
  paymentRequired: boolean;
  identityDocumentRequested: boolean;
  suspiciousContactDomain: boolean;
  agencyEmployerUnknown: boolean;
  repostCount90Days: number;
  employerIdentityVerified: boolean;
  postingDateAvailable: boolean;
  extractionConfidence: VerificationExtractionConfidence;
}

export interface AssessLegitimacyInput {
  opportunityId: string;
  verification: OpportunityVerificationBundle;
  observations: LegitimacyObservations;
  assessedAt: string;
}

function signal(code: string, severity: LegitimacySignalSeverity, evidence: string): LegitimacySignal {
  return { code, severity, evidence };
}

function requiredTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("legitimacy assessment time must be a valid date-time");
  return new Date(value).toISOString();
}

function validateObservations(value: LegitimacyObservations): void {
  if (!Number.isSafeInteger(value.repostCount90Days) || value.repostCount90Days < 0) {
    throw new Error("repost count must be a non-negative integer");
  }
}

function canonicalAssessment(assessment: Omit<LegitimacyAssessment, "assessmentHash">): string {
  return stableStringify(assessment);
}

export function assessLegitimacy(input: AssessLegitimacyInput): LegitimacyAssessment {
  validateObservations(input.observations);
  const signals: LegitimacySignal[] = [];

  if (input.verification.opportunityId !== input.opportunityId) {
    signals.push(signal(
      "verification-opportunity-mismatch",
      "blocking",
      "verification bundle is bound to a different opportunity"
    ));
  }
  if (input.verification.status !== "verified") {
    signals.push(signal(
      "verification-not-current",
      "blocking",
      `verification bundle status is ${input.verification.status}`
    ));
  }
  if (input.observations.paymentRequired) {
    signals.push(signal(
      "payment-required",
      "blocking",
      "the application route requires payment before a normal application can proceed"
    ));
  }
  if (input.observations.identityDocumentRequested) {
    signals.push(signal(
      "identity-document-requested",
      "blocking",
      "an identity document is requested at the application stage"
    ));
  }
  if (input.observations.suspiciousContactDomain) {
    signals.push(signal(
      "suspicious-contact-domain",
      "blocking",
      "the contact domain is not consistent with a verified employer or authorised hiring route"
    ));
  }
  if (!input.observations.employerIdentityVerified) {
    signals.push(signal(
      "employer-identity-unverified",
      "blocking",
      "the hiring entity identity could not be verified"
    ));
  }
  if (input.observations.agencyEmployerUnknown) {
    signals.push(signal(
      "agency-employer-unknown",
      "warning",
      "the agency route does not disclose the end employer"
    ));
  }
  if (input.observations.repostCount90Days >= 3) {
    signals.push(signal(
      "repeated-reposting",
      "warning",
      `the opportunity family was observed ${input.observations.repostCount90Days} times in 90 days`
    ));
  }
  if (!input.observations.postingDateAvailable) {
    signals.push(signal(
      "posting-date-unavailable",
      "warning",
      "the posting date is unavailable"
    ));
  }
  if (input.observations.extractionConfidence !== "high") {
    signals.push(signal(
      "extraction-confidence-limited",
      "warning",
      `opportunity extraction confidence is ${input.observations.extractionConfidence}`
    ));
  }

  const tier: LegitimacyTier = signals.some((entry) => entry.severity === "blocking")
    ? "red"
    : signals.some((entry) => entry.severity === "warning")
      ? "yellow"
      : "green";
  const withoutHash: Omit<LegitimacyAssessment, "assessmentHash"> = {
    opportunityId: input.opportunityId,
    tier,
    signals,
    assessedAt: requiredTimestamp(input.assessedAt)
  };
  const assessment: LegitimacyAssessment = {
    ...withoutHash,
    assessmentHash: sha256(canonicalAssessment(withoutHash))
  };
  assertSchema("legitimacy-assessment", assessment);
  return assessment;
}
