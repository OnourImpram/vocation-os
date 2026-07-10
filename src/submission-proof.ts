import { sha256, stableStringify } from "./hash.js";
import { assertSchema } from "./schema.js";

export const SUBMISSION_PROOF_KINDS = ["confirmation-page", "ats-dashboard", "sent-items", "receipt-email"] as const;
export type SubmissionProofKind = (typeof SUBMISSION_PROOF_KINDS)[number];

export interface SubmissionProof {
  proofId: string;
  opportunityId: string;
  kind: SubmissionProofKind;
  capturedAt: string;
  sourcePointer: string;
  officialRoute: boolean;
  indicators: string[];
  recipientDomain: string | null;
  senderDomain: string | null;
  attachmentCount: number | null;
  referenceId: string | null;
  sentAt: string | null;
  evidenceHash: string;
}

export interface SubmissionProofDraft {
  proofId?: string | undefined;
  opportunityId: string;
  kind: SubmissionProofKind;
  capturedAt?: string | undefined;
  sourcePointer: string;
  officialRoute: boolean;
  indicators?: string[] | undefined;
  recipientDomain?: string | null | undefined;
  senderDomain?: string | null | undefined;
  attachmentCount?: number | null | undefined;
  referenceId?: string | null | undefined;
  sentAt?: string | null | undefined;
}

export interface SubmissionProofPolicy {
  requireOfficialRoute: boolean;
  emailAttachmentRequired: boolean;
}

export interface SubmissionProofEvaluation {
  proofId: string;
  opportunityId: string;
  status: "confirmed" | "insufficient" | "rejected";
  reasons: string[];
  ledgerEligible: boolean;
}

const MAX_INDICATORS = 20;
const MAX_INDICATOR_LENGTH = 200;
const MAX_SOURCE_POINTER_LENGTH = 200;
const SAFE_SOURCE_POINTER = /^(redacted|local|proof):[A-Za-z0-9._:/-]+$/;

const POSITIVE_PATTERNS = [
  /application (?:has been )?received/i,
  /thank you for applying/i,
  /application (?:was )?submitted/i,
  /successfully submitted/i,
  /we (?:have )?received your application/i,
  /application complete/i
];

const NEGATIVE_PATTERNS = [
  /security code/i,
  /verification code/i,
  /resubmit/i,
  /application (?:is )?incomplete/i,
  /submission failed/i,
  /application (?:was )?not submitted/i,
  /application (?:was )?not received/i,
  /finish your application/i,
  /complete your application/i,
  /pending submission/i
];

export function defaultSubmissionProofPolicy(): SubmissionProofPolicy {
  return {
    requireOfficialRoute: true,
    emailAttachmentRequired: true
  };
}

function normalizeIndicator(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeSourcePointer(value: string): string {
  const normalized = value.trim();
  if (normalized.length > MAX_SOURCE_POINTER_LENGTH) {
    throw new Error(`Submission proof source pointers must not exceed ${MAX_SOURCE_POINTER_LENGTH} characters`);
  }
  if (normalized.includes("://") || !SAFE_SOURCE_POINTER.test(normalized)) {
    throw new Error("Submission proof source pointers must use a redacted:, local:, or proof: reference without URLs or query data");
  }
  return normalized;
}

function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(normalized) || !normalized.includes(".")) {
    throw new Error("Domain evidence must be a host name without an email address");
  }
  return normalized;
}

function canonicalProof(proof: Omit<SubmissionProof, "evidenceHash">): string {
  return stableStringify(proof);
}

export function computeSubmissionProofHash(proof: Omit<SubmissionProof, "evidenceHash">): string {
  return sha256(canonicalProof(proof));
}

export function buildSubmissionProof(draft: SubmissionProofDraft): SubmissionProof {
  const indicators = [...new Set((draft.indicators ?? []).map(normalizeIndicator).filter(Boolean))];
  if (indicators.length > MAX_INDICATORS) {
    throw new Error(`Submission proof accepts at most ${MAX_INDICATORS} indicators`);
  }
  if (indicators.some((indicator) => indicator.length > MAX_INDICATOR_LENGTH)) {
    throw new Error(`Submission proof indicators must not exceed ${MAX_INDICATOR_LENGTH} characters`);
  }

  const capturedAt = draft.capturedAt ?? new Date().toISOString();
  const sourcePointer = normalizeSourcePointer(draft.sourcePointer);
  const identitySeed = stableStringify({
    opportunityId: draft.opportunityId,
    kind: draft.kind,
    capturedAt,
    sourcePointer
  });
  const proofId = draft.proofId ?? `PRF-${sha256(identitySeed).slice("sha256:".length, "sha256:".length + 16).toUpperCase()}`;
  const proofWithoutHash: Omit<SubmissionProof, "evidenceHash"> = {
    proofId,
    opportunityId: draft.opportunityId,
    kind: draft.kind,
    capturedAt,
    sourcePointer,
    officialRoute: draft.officialRoute,
    indicators,
    recipientDomain: normalizeDomain(draft.recipientDomain),
    senderDomain: normalizeDomain(draft.senderDomain),
    attachmentCount: draft.attachmentCount ?? null,
    referenceId: draft.referenceId?.trim() || null,
    sentAt: draft.sentAt ?? null
  };
  const proof: SubmissionProof = {
    ...proofWithoutHash,
    evidenceHash: computeSubmissionProofHash(proofWithoutHash)
  };
  assertSchema("submission-proof", proof);
  return proof;
}

function hasPositiveIndicator(indicators: string[]): boolean {
  return indicators.some((indicator) => POSITIVE_PATTERNS.some((pattern) => pattern.test(indicator)));
}

function negativeIndicators(indicators: string[]): string[] {
  return indicators.filter((indicator) => NEGATIVE_PATTERNS.some((pattern) => pattern.test(indicator)));
}

function evaluation(proof: SubmissionProof, status: SubmissionProofEvaluation["status"], reasons: string[]): SubmissionProofEvaluation {
  return {
    proofId: proof.proofId,
    opportunityId: proof.opportunityId,
    status,
    reasons,
    ledgerEligible: status === "confirmed"
  };
}

export function evaluateSubmissionProof(
  proof: SubmissionProof,
  policy: SubmissionProofPolicy = defaultSubmissionProofPolicy()
): SubmissionProofEvaluation {
  assertSchema("submission-proof", proof);
  const { evidenceHash: _evidenceHash, ...proofWithoutHash } = proof;
  if (computeSubmissionProofHash(proofWithoutHash) !== proof.evidenceHash) {
    return evaluation(proof, "rejected", ["evidence hash does not match the proof record"]);
  }
  if (policy.requireOfficialRoute && !proof.officialRoute) {
    return evaluation(proof, "rejected", ["proof does not come from an official application route"]);
  }

  const negatives = negativeIndicators(proof.indicators);
  if (negatives.length > 0) {
    return evaluation(proof, "rejected", ["proof contains a non completion signal", ...negatives]);
  }

  if (proof.kind === "sent-items") {
    const reasons: string[] = [];
    if (!proof.recipientDomain) {
      reasons.push("recipient domain is missing");
    }
    if (!proof.sentAt) {
      reasons.push("Sent Items timestamp is missing");
    }
    if (policy.emailAttachmentRequired && (proof.attachmentCount ?? 0) < 1) {
      reasons.push("required application attachment is missing");
    }
    return reasons.length === 0 ? evaluation(proof, "confirmed", ["Sent Items evidence satisfies the email policy"]) : evaluation(proof, "insufficient", reasons);
  }

  if (proof.kind === "ats-dashboard") {
    const reasons: string[] = [];
    if (!proof.referenceId) {
      reasons.push("ATS application reference is missing");
    }
    if (!hasPositiveIndicator(proof.indicators)) {
      reasons.push("ATS dashboard has no positive completion indicator");
    }
    return reasons.length === 0 ? evaluation(proof, "confirmed", ["ATS dashboard record confirms completion"]) : evaluation(proof, "insufficient", reasons);
  }

  if (proof.kind === "receipt-email") {
    const reasons: string[] = [];
    if (!proof.senderDomain) {
      reasons.push("receipt sender domain is missing");
    }
    if (!hasPositiveIndicator(proof.indicators)) {
      reasons.push("receipt email has no positive completion indicator");
    }
    return reasons.length === 0 ? evaluation(proof, "confirmed", ["official receipt email confirms completion"]) : evaluation(proof, "insufficient", reasons);
  }

  return hasPositiveIndicator(proof.indicators)
    ? evaluation(proof, "confirmed", ["official confirmation page confirms completion"])
    : evaluation(proof, "insufficient", ["confirmation page has no positive completion indicator"]);
}
