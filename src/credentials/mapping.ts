import { sha256, stableStringify } from "../hash.js";
import { assertCredentialContract } from "./schema.js";
import type {
  CredentialClaimMapping,
  CredentialClaimMappingDraft,
  CredentialMappingApproval,
  CredentialPassportEntry
} from "./types.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN_IDENTIFIERS = new Set(["__proto__", "constructor", "prototype"]);

type CredentialMappingBinding = Pick<
  CredentialClaimMapping,
  | "mappingId"
  | "credentialId"
  | "credentialHash"
  | "claimType"
  | "claimText"
  | "sourcePointer"
  | "requestedPublic"
  | "requestedAutoApply"
>;

function mappingPayload(mapping: CredentialMappingBinding): Record<string, unknown> {
  return {
    mappingId: mapping.mappingId,
    credentialId: mapping.credentialId,
    credentialHash: mapping.credentialHash,
    claimType: mapping.claimType,
    claimText: mapping.claimText,
    sourcePointer: mapping.sourcePointer,
    requestedPublic: mapping.requestedPublic,
    requestedAutoApply: mapping.requestedAutoApply
  };
}

function validIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    !FORBIDDEN_IDENTIFIERS.has(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validClaimText(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= 4000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\u2060\ufeff]/u.test(value)
  );
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function hasAudienceRestriction(entry: CredentialPassportEntry): boolean {
  if (entry.credential.termsOfUse !== undefined) return true;
  const subject = entry.credential.credentialSubject;
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) return false;
  const achievement = subject.achievement;
  return achievement !== null
    && typeof achievement === "object"
    && !Array.isArray(achievement)
    && achievement.audience !== undefined;
}

function assertPassportEntryEligible(entry: CredentialPassportEntry): void {
  assertCredentialContract("credential-passport", entry);
  if (!entry.verification.eligibleForMapping || entry.verification.overall !== "verified") {
    throw new Error("Credential is not eligible for claim mapping");
  }
  if (entry.canonicalCredentialHash !== sha256(stableStringify(entry.credential))) {
    throw new Error("Credential passport canonical hash is invalid");
  }
  const expectedEntryId = `CREDENTIAL-${entry.original.hash.slice("sha256:".length).toUpperCase()}`;
  if (entry.passportEntryId !== expectedEntryId) {
    throw new Error("Credential passport entry id is not bound to the original hash");
  }
}

function assertMappingBound(
  entry: CredentialPassportEntry,
  mapping: CredentialClaimMapping
): void {
  assertCredentialContract("credential-mapping", mapping);
  if (
    mapping.credentialHash !== entry.canonicalCredentialHash
    || mapping.credentialId !== entry.summary.credentialId
  ) {
    throw new Error("Credential mapping is not bound to this passport entry");
  }
  if (mapping.mappingHash !== computeCredentialMappingHash(mapping)) {
    throw new Error("Credential mapping hash is invalid");
  }
}

function assertApprovalValid(
  entry: CredentialPassportEntry,
  mapping: CredentialClaimMapping,
  approval: CredentialMappingApproval,
  nowMs: number
): void {
  if (approval.mappingHash !== mapping.mappingHash) {
    throw new Error("Credential mapping approval hash does not match the mapping");
  }
  if (!validIdentifier(approval.approvalId) || !validIdentifier(approval.approverPrincipalId)) {
    throw new Error("Credential mapping approval identity is invalid");
  }
  if (!SHA256_PATTERN.test(approval.signatureReceiptHash)) {
    throw new Error("Credential mapping approval signature receipt hash is invalid");
  }
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (
    !Number.isFinite(approvedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= approvedAt
    || expiresAt - approvedAt > MAX_APPROVAL_WINDOW_MS
    || approvedAt > nowMs + MAX_CLOCK_SKEW_MS
    || expiresAt <= nowMs
  ) {
    throw new Error("Credential mapping approval is not currently valid");
  }
  if (approval.allowPublic && !mapping.requestedPublic) {
    throw new Error("Credential mapping approval exceeds the requested public scope");
  }
  if (
    approval.allowAutoApply
    && (!mapping.requestedAutoApply || !mapping.requestedPublic || !approval.allowPublic)
  ) {
    throw new Error("Credential mapping approval exceeds the requested automatic scope");
  }
  if ((approval.allowPublic || approval.allowAutoApply) && hasAudienceRestriction(entry)) {
    throw new Error("Audience restricted credentials cannot be approved for public or automatic use");
  }
}

export function computeCredentialMappingHash(mapping: CredentialMappingBinding): string {
  return sha256(stableStringify(mappingPayload(mapping)));
}

export function createCredentialClaimMapping(
  entry: CredentialPassportEntry,
  draft: CredentialClaimMappingDraft
): CredentialClaimMapping {
  if (!validIdentifier(draft.mappingId)) throw new Error("Credential mapping id is invalid");
  if (!validClaimText(draft.claimText)) throw new Error("Credential mapping claim text is invalid");
  if (!entry.summary.credentialId) throw new Error("Credential id is required before claim mapping");
  const requestedPublic = draft.requestedPublic ?? false;
  const requestedAutoApply = draft.requestedAutoApply ?? false;
  if (requestedAutoApply && !requestedPublic) {
    throw new Error("Automatic use cannot be requested without public disclosure review");
  }
  const withoutHash: CredentialClaimMapping = {
    mappingId: draft.mappingId,
    credentialId: entry.summary.credentialId,
    credentialHash: entry.canonicalCredentialHash,
    claimType: draft.claimType,
    claimText: draft.claimText.trim(),
    sourcePointer: `credential:${entry.original.hash}#credentialSubject.achievement`,
    requestedPublic,
    requestedAutoApply,
    publiclyAssertable: false,
    allowedInAutoApply: false,
    status: "pending",
    mappingHash: "",
    approval: null
  };
  const mapping = {
    ...withoutHash,
    mappingHash: computeCredentialMappingHash(withoutHash)
  };
  assertCredentialContract("credential-mapping", mapping);
  return freeze(mapping);
}

export function approveCredentialClaimMapping(
  entry: CredentialPassportEntry,
  mapping: CredentialClaimMapping,
  approval: CredentialMappingApproval,
  now = new Date()
): CredentialClaimMapping {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Credential mapping approval time is invalid");
  assertPassportEntryEligible(entry);
  if (mapping.status !== "pending" || mapping.approval !== null) {
    throw new Error("Credential mapping has already been approved");
  }
  assertMappingBound(entry, mapping);
  assertApprovalValid(entry, mapping, approval, nowMs);
  const approved: CredentialClaimMapping = {
    ...mapping,
    publiclyAssertable: approval.allowPublic,
    allowedInAutoApply: approval.allowAutoApply,
    status: "approved",
    approval: { ...approval }
  };
  assertCredentialContract("credential-mapping", approved);
  return freeze(approved);
}

export function addCredentialMapping(
  entry: CredentialPassportEntry,
  mapping: CredentialClaimMapping,
  now = new Date()
): CredentialPassportEntry {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Credential mapping attachment time is invalid");
  if (mapping.status !== "approved" || mapping.approval === null) {
    throw new Error("Credential mapping requires explicit approval before it can enter the passport");
  }
  assertPassportEntryEligible(entry);
  assertMappingBound(entry, mapping);
  assertApprovalValid(entry, mapping, mapping.approval, nowMs);
  if (
    mapping.publiclyAssertable !== mapping.approval.allowPublic
    || mapping.allowedInAutoApply !== mapping.approval.allowAutoApply
  ) {
    throw new Error("Credential mapping flags do not match the explicit approval");
  }
  if (entry.mappings.some((candidate) => candidate.mappingId === mapping.mappingId)) {
    throw new Error(`Credential mapping already exists: ${mapping.mappingId}`);
  }
  const updated: CredentialPassportEntry = {
    ...entry,
    mappings: [...entry.mappings, mapping].sort((left, right) => left.mappingId.localeCompare(right.mappingId))
  };
  assertCredentialContract("credential-passport", updated);
  return freeze(updated);
}

export const createCredentialMapping = createCredentialClaimMapping;
export const approveCredentialMapping = approveCredentialClaimMapping;
export const attachCredentialMapping = addCredentialMapping;
