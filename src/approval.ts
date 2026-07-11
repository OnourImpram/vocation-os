import { createPublicKey, randomUUID, sign, verify, type KeyLike } from "node:crypto";
import { computeActionIntentHash, stableStringify } from "./hash.js";
import { validateAgainstSchema } from "./schema.js";
import type { ApprovalReference, ReversibilityTag } from "./types.js";

export interface ApprovalScope {
  operation: ApprovalReference["operation"];
  opportunityId: string;
  packetHash: string;
  adapterId: string;
  reversibilityTag: ReversibilityTag;
  requiredField: string;
  now: Date;
}

export interface ApprovalValidationResult {
  valid: boolean;
  blockedBy?: string;
  reasons: string[];
}

export interface TrustedApprover {
  approvedBy: string;
  keyId: string;
  publicKeyPem: string;
}

export type ApprovalReferenceDraft = Omit<ApprovalReference, "approvalId" | "signatureAlgorithm" | "signature"> & {
  approvalId?: string;
};

function unsignedApproval(approval: ApprovalReference): Omit<ApprovalReference, "signatureAlgorithm" | "signature"> {
  const { signatureAlgorithm: _algorithm, signature: _signature, ...unsigned } = approval;
  return unsigned;
}

export function createApprovalReference(draft: ApprovalReferenceDraft, privateKey: KeyLike): ApprovalReference {
  const unsigned: Omit<ApprovalReference, "signatureAlgorithm" | "signature"> = {
    approvalId: draft.approvalId ?? `APR-${randomUUID().toUpperCase()}`,
    operation: draft.operation,
    approvedBy: draft.approvedBy,
    keyId: draft.keyId,
    approvedAt: draft.approvedAt,
    expiresAt: draft.expiresAt,
    approvalTextHash: draft.approvalTextHash,
    opportunityId: draft.opportunityId,
    packetHash: draft.packetHash,
    adapterId: draft.adapterId,
    actionIntentHash: draft.actionIntentHash,
    allowedFields: [...draft.allowedFields]
  };
  const signature = sign(null, Buffer.from(stableStringify(unsigned), "utf8"), privateKey).toString("base64url");
  const approval: ApprovalReference = {
    ...unsigned,
    signatureAlgorithm: "Ed25519",
    signature
  };
  const schemaValidation = validateAgainstSchema("approval-reference", approval);
  if (!schemaValidation.valid) throw new Error(`Approval schema validation failed: ${schemaValidation.errors.join(", ")}`);
  return approval;
}

export function validateApprovalReference(
  approval: ApprovalReference,
  scope: ApprovalScope,
  trustedApprovers: readonly TrustedApprover[]
): ApprovalValidationResult {
  const schemaValidation = validateAgainstSchema("approval-reference", approval);
  if (!schemaValidation.valid) {
    return { valid: false, blockedBy: "approval-invalid", reasons: schemaValidation.errors };
  }
  const trustedApprover = trustedApprovers.find(
    (candidate) => candidate.approvedBy === approval.approvedBy && candidate.keyId === approval.keyId
  );
  if (!trustedApprover) {
    return { valid: false, blockedBy: "approver-not-trusted", reasons: ["approval signer is not in the trusted approver registry"] };
  }
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(stableStringify(unsignedApproval(approval)), "utf8"),
      createPublicKey(trustedApprover.publicKeyPem),
      Buffer.from(approval.signature, "base64url")
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { valid: false, blockedBy: "approval-signature-invalid", reasons: ["approval signature is invalid"] };
  }
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (approvedAt > scope.now.getTime() + 300_000 || expiresAt <= approvedAt) {
    return { valid: false, blockedBy: "approval-timestamp-invalid", reasons: ["approval timestamps are inconsistent"] };
  }
  if (expiresAt <= scope.now.getTime()) {
    return { valid: false, blockedBy: "approval-expired", reasons: ["approval has expired"] };
  }
  if (expiresAt - approvedAt > 86_400_000) {
    return { valid: false, blockedBy: "approval-window-too-wide", reasons: ["approval validity must not exceed 24 hours"] };
  }
  const expectedIntentHash = computeActionIntentHash({
    operation: scope.operation,
    opportunityId: scope.opportunityId,
    packetHash: scope.packetHash,
    adapterId: scope.adapterId,
    reversibilityTag: scope.reversibilityTag
  });
  if (
    approval.operation !== scope.operation ||
    approval.opportunityId !== scope.opportunityId ||
    approval.packetHash !== scope.packetHash ||
    approval.adapterId !== scope.adapterId ||
    approval.actionIntentHash !== expectedIntentHash ||
    !approval.allowedFields.includes(scope.requiredField)
  ) {
    return { valid: false, blockedBy: "approval-scope-mismatch", reasons: ["approval is not bound to this action intent"] };
  }
  return { valid: true, reasons: [] };
}
