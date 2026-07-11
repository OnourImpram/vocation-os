import { createPublicKey, sign, verify, type KeyLike } from "node:crypto";
import { sha256, stableStringify } from "./hash.js";
import { assertSchema } from "./schema.js";

export const SUBMISSION_PROOF_KINDS = ["confirmation-page", "ats-dashboard", "sent-items", "receipt-email"] as const;
export type SubmissionProofKind = (typeof SUBMISSION_PROOF_KINDS)[number];

export interface SubmissionObservation {
  collectorId: string;
  collectorVersion: string;
  keyId: string;
  attemptId: string;
  actionIntentHash: string;
  opportunityId: string;
  packetHash: string;
  adapterId: string;
  kind: SubmissionProofKind;
  capturedAt: string;
  sourceDomain: string;
  sourcePointer: string;
  indicators: string[];
  recipientDomain: string | null;
  attachmentCount: number | null;
  referenceId: string | null;
  sentAt: string | null;
  payloadHash: string;
}

export interface SubmissionProof extends SubmissionObservation {
  proofId: string;
  receiptHash: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export interface SubmissionObservationDraft {
  collectorId: string;
  collectorVersion: string;
  keyId: string;
  attemptId: string;
  actionIntentHash: string;
  opportunityId: string;
  packetHash: string;
  adapterId: string;
  kind: SubmissionProofKind;
  capturedAt?: string;
  sourceDomain: string;
  sourcePointer: string;
  indicators?: string[];
  recipientDomain?: string | null;
  attachmentCount?: number | null;
  referenceId?: string | null;
  sentAt?: string | null;
  payloadHash: string;
}

export interface TrustedCollector {
  collectorId: string;
  keyId: string;
  publicKeyPem: string;
  allowedAdapters: string[];
  allowedSourceDomains: string[];
  allowedKinds: SubmissionProofKind[];
}

export interface SubmissionProofPolicy {
  emailAttachmentRequired: boolean;
}

export interface SubmissionProofExpectation {
  attemptId: string;
  actionIntentHash: string;
  opportunityId: string;
  packetHash: string;
  adapterId: string;
  submittedAt: string;
  evaluatedAt?: string;
}

export interface SubmissionProofEvaluation {
  proofId: string;
  opportunityId: string;
  status: "confirmed" | "insufficient" | "rejected";
  reasons: string[];
  ledgerEligible: boolean;
  collectorId: string;
}

const MAX_INDICATORS = 20;
const MAX_INDICATOR_LENGTH = 200;
const MAX_SOURCE_POINTER_LENGTH = 200;
const MAX_REFERENCE_ID_LENGTH = 64;
const SAFE_SOURCE_POINTER = /^(redacted|local|proof):[A-Za-z0-9._:/-]+$/;
const SAFE_REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DOMAIN_PATTERN = /^[a-z0-9.-]+$/;

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
  return { emailAttachmentRequired: true };
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

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized) || !normalized.includes(".")) {
    throw new Error("Submission proof domains must be host names without email addresses");
  }
  return normalized;
}

function normalizeOptionalDomain(value: string | null | undefined): string | null {
  return value ? normalizeDomain(value) : null;
}

function normalizeReferenceId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.length > MAX_REFERENCE_ID_LENGTH || !SAFE_REFERENCE_ID.test(normalized)) {
    throw new Error("Submission proof reference ids must be bounded opaque identifiers without URLs, email addresses, or query data");
  }
  return normalized;
}

function canonicalObservation(observation: SubmissionObservation): string {
  return stableStringify(observation);
}

export function computeSubmissionReceiptHash(observation: SubmissionObservation): string {
  return sha256(canonicalObservation(observation));
}

export function createSubmissionProof(draft: SubmissionObservationDraft, privateKey: KeyLike): SubmissionProof {
  const indicators = [...new Set((draft.indicators ?? []).map(normalizeIndicator).filter(Boolean))];
  if (indicators.length > MAX_INDICATORS) {
    throw new Error(`Submission proof accepts at most ${MAX_INDICATORS} indicators`);
  }
  if (indicators.some((indicator) => indicator.length > MAX_INDICATOR_LENGTH)) {
    throw new Error(`Submission proof indicators must not exceed ${MAX_INDICATOR_LENGTH} characters`);
  }

  const observation: SubmissionObservation = {
    collectorId: draft.collectorId.trim(),
    collectorVersion: draft.collectorVersion.trim(),
    keyId: draft.keyId.trim(),
    attemptId: draft.attemptId,
    actionIntentHash: draft.actionIntentHash,
    opportunityId: draft.opportunityId,
    packetHash: draft.packetHash,
    adapterId: draft.adapterId.trim(),
    kind: draft.kind,
    capturedAt: draft.capturedAt ?? new Date().toISOString(),
    sourceDomain: normalizeDomain(draft.sourceDomain),
    sourcePointer: normalizeSourcePointer(draft.sourcePointer),
    indicators,
    recipientDomain: normalizeOptionalDomain(draft.recipientDomain),
    attachmentCount: draft.attachmentCount ?? null,
    referenceId: normalizeReferenceId(draft.referenceId),
    sentAt: draft.sentAt ?? null,
    payloadHash: draft.payloadHash
  };
  const receiptHash = computeSubmissionReceiptHash(observation);
  const signature = sign(null, Buffer.from(receiptHash, "utf8"), privateKey).toString("base64url");
  const proof: SubmissionProof = {
    ...observation,
    proofId: `PRF-${receiptHash.slice("sha256:".length, "sha256:".length + 20).toUpperCase()}`,
    receiptHash,
    signatureAlgorithm: "Ed25519",
    signature
  };
  assertSchema("submission-proof", proof);
  return proof;
}

function evaluation(
  proof: SubmissionProof,
  status: SubmissionProofEvaluation["status"],
  reasons: string[]
): SubmissionProofEvaluation {
  return {
    proofId: proof.proofId,
    opportunityId: proof.opportunityId,
    status,
    reasons,
    ledgerEligible: status === "confirmed",
    collectorId: proof.collectorId
  };
}

function positiveIndicatorExists(indicators: string[]): boolean {
  return indicators.some((indicator) => POSITIVE_PATTERNS.some((pattern) => pattern.test(indicator)));
}

function negativeIndicators(indicators: string[]): string[] {
  return indicators.filter((indicator) => NEGATIVE_PATTERNS.some((pattern) => pattern.test(indicator)));
}

export function evaluateSubmissionProof(
  proof: SubmissionProof,
  trustedCollectors: readonly TrustedCollector[],
  expectation: SubmissionProofExpectation,
  policy: SubmissionProofPolicy = defaultSubmissionProofPolicy()
): SubmissionProofEvaluation {
  const schemaResult = (() => {
    try {
      assertSchema("submission-proof", proof);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  if (schemaResult) {
    return evaluation(proof, "rejected", [schemaResult]);
  }

  const collector = trustedCollectors.find(
    (candidate) => candidate.collectorId === proof.collectorId && candidate.keyId === proof.keyId
  );
  if (!collector) {
    return evaluation(proof, "rejected", ["collector is not trusted"]);
  }
  if (!collector.allowedAdapters.includes(proof.adapterId)) {
    return evaluation(proof, "rejected", ["collector is not allowed for this adapter"]);
  }
  if (!collector.allowedSourceDomains.includes(proof.sourceDomain)) {
    return evaluation(proof, "rejected", ["source domain is not trusted for this collector"]);
  }
  if (!collector.allowedKinds.includes(proof.kind)) {
    return evaluation(proof, "rejected", ["collector is not allowed for this proof kind"]);
  }
  if (
    proof.attemptId !== expectation.attemptId ||
    proof.actionIntentHash !== expectation.actionIntentHash ||
    proof.opportunityId !== expectation.opportunityId ||
    proof.packetHash !== expectation.packetHash ||
    proof.adapterId !== expectation.adapterId
  ) {
    return evaluation(proof, "rejected", ["proof binding does not match the application attempt"]);
  }

  const capturedAt = Date.parse(proof.capturedAt);
  const submittedAt = Date.parse(expectation.submittedAt);
  const evaluatedAt = Date.parse(expectation.evaluatedAt ?? new Date().toISOString());
  const clockSkewMs = 300_000;
  if (!Number.isFinite(submittedAt) || !Number.isFinite(evaluatedAt)) {
    return evaluation(proof, "rejected", ["proof evaluation timestamps are invalid"]);
  }
  if (capturedAt + clockSkewMs < submittedAt || capturedAt > evaluatedAt + clockSkewMs) {
    return evaluation(proof, "rejected", ["proof capture time is outside the application attempt window"]);
  }

  const { proofId: _proofId, receiptHash: _receiptHash, signatureAlgorithm: _algorithm, signature: _signature, ...observation } = proof;
  if (computeSubmissionReceiptHash(observation) !== proof.receiptHash) {
    return evaluation(proof, "rejected", ["receipt hash does not match the collector observation"]);
  }
  const signatureValid = verify(
    null,
    Buffer.from(proof.receiptHash, "utf8"),
    createPublicKey(collector.publicKeyPem),
    Buffer.from(proof.signature, "base64url")
  );
  if (!signatureValid) {
    return evaluation(proof, "rejected", ["collector signature is invalid"]);
  }

  const negatives = negativeIndicators(proof.indicators);
  if (negatives.length > 0) {
    return evaluation(proof, "rejected", ["proof contains a non completion signal", ...negatives]);
  }

  if (proof.kind === "sent-items") {
    const reasons: string[] = [];
    if (!proof.recipientDomain) reasons.push("recipient domain is missing");
    if (!proof.sentAt) reasons.push("Sent Items timestamp is missing");
    if (proof.sentAt) {
      const sentAt = Date.parse(proof.sentAt);
      if (!Number.isFinite(sentAt) || sentAt + clockSkewMs < submittedAt || sentAt > capturedAt + clockSkewMs) {
        reasons.push("Sent Items timestamp is outside the application attempt window");
      }
    }
    if (policy.emailAttachmentRequired && (proof.attachmentCount ?? 0) < 1) reasons.push("required application attachment is missing");
    return reasons.length === 0
      ? evaluation(proof, "confirmed", ["trusted Sent Items collector satisfies the email policy"])
      : evaluation(proof, "insufficient", reasons);
  }

  if (proof.kind === "ats-dashboard" && !proof.referenceId) {
    return evaluation(proof, "insufficient", ["ATS application reference is missing"]);
  }
  return positiveIndicatorExists(proof.indicators)
    ? evaluation(proof, "confirmed", ["trusted collector confirms completion"])
    : evaluation(proof, "insufficient", ["proof has no positive completion indicator"]);
}
