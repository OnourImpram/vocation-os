import { randomUUID } from "node:crypto";
import { createActionId } from "./action-ledger.js";
import { validateApprovalReference, type TrustedApprover } from "./approval.js";
import { computeActionIntentHash } from "./hash.js";
import { assertSchema } from "./schema.js";
import {
  evaluateSubmissionProof,
  type SubmissionProof,
  type SubmissionProofEvaluation,
  type SubmissionProofPolicy,
  type TrustedCollector
} from "./submission-proof.js";
import { HIGH_STAKES_FLAGS, type ActionLedgerEntry, type ApprovalReference, type HighStakesFlags, type ReversibilityTag } from "./types.js";

export const APPLICATION_CHANNELS = ["ats-form", "official-email", "platform-profile", "other"] as const;
export const APPLICATION_ATTEMPT_STATUSES = ["prepared", "approved", "submitted_unconfirmed", "confirmed", "blocked"] as const;

export type ApplicationChannel = (typeof APPLICATION_CHANNELS)[number];
export type ApplicationAttemptStatus = (typeof APPLICATION_ATTEMPT_STATUSES)[number];

export interface ApplicationAttempt {
  attemptId: string;
  opportunityId: string;
  packetHash: string;
  adapterId: string;
  channel: ApplicationChannel;
  reversibilityTag: ReversibilityTag;
  highStakesGatePassed: boolean;
  actionIntentHash: string;
  status: ApplicationAttemptStatus;
  createdAt: string;
  updatedAt: string;
  approvalId: string | null;
  proofId: string | null;
  proofReceiptHash: string | null;
  collectorId: string | null;
  blocker: string | null;
}

export interface ApplicationAttemptInput {
  opportunityId: string;
  packetHash: string;
  adapterId: string;
  channel: ApplicationChannel;
  reversibilityTag: ReversibilityTag;
  highStakesFlags: HighStakesFlags;
  now?: Date;
}

function assertTransition(attempt: ApplicationAttempt, expected: ApplicationAttemptStatus): void {
  if (attempt.status !== expected) {
    throw new Error(`Application attempt ${attempt.attemptId} must be ${expected}, found ${attempt.status}`);
  }
}

function validated(attempt: ApplicationAttempt): ApplicationAttempt {
  assertSchema("application-attempt", attempt);
  return attempt;
}

export function createApplicationAttempt(input: ApplicationAttemptInput): ApplicationAttempt {
  const now = input.now ?? new Date();
  if (!HIGH_STAKES_FLAGS.every((flag) => typeof input.highStakesFlags[flag] === "boolean")) {
    throw new Error("All high stakes flags require explicit boolean assessment");
  }
  const highStakesGatePassed = HIGH_STAKES_FLAGS.every((flag) => input.highStakesFlags[flag] === false);
  const actionIntentHash = computeActionIntentHash({
    operation: "auto-apply",
    opportunityId: input.opportunityId,
    packetHash: input.packetHash,
    adapterId: input.adapterId,
    reversibilityTag: input.reversibilityTag
  });
  return validated({
    attemptId: `ATT-${now.getUTCFullYear()}-${randomUUID()}`,
    opportunityId: input.opportunityId,
    packetHash: input.packetHash,
    adapterId: input.adapterId,
    channel: input.channel,
    reversibilityTag: input.reversibilityTag,
    highStakesGatePassed,
    actionIntentHash,
    status: "prepared",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    approvalId: null,
    proofId: null,
    proofReceiptHash: null,
    collectorId: null,
    blocker: null
  });
}

export function approveApplicationAttempt(
  attempt: ApplicationAttempt,
  approval: ApprovalReference,
  trustedApprovers: readonly TrustedApprover[],
  now = new Date()
): ApplicationAttempt {
  assertTransition(attempt, "prepared");
  const approvalValidation = validateApprovalReference(
    approval,
    {
      operation: "auto-apply",
      opportunityId: attempt.opportunityId,
      packetHash: attempt.packetHash,
      adapterId: attempt.adapterId,
      reversibilityTag: attempt.reversibilityTag,
      requiredField: "application-packet",
      now
    },
    trustedApprovers
  );
  if (!approvalValidation.valid) {
    throw new Error(`${approvalValidation.blockedBy ?? "approval-invalid"}: ${approvalValidation.reasons.join(", ")}`);
  }
  return validated({
    ...attempt,
    status: "approved",
    updatedAt: now.toISOString(),
    approvalId: approval.approvalId
  });
}

export function markSubmissionAttempted(attempt: ApplicationAttempt, now = new Date()): ApplicationAttempt {
  assertTransition(attempt, "approved");
  if (!attempt.highStakesGatePassed) {
    throw new Error("High stakes gate must pass before submission can be attempted");
  }
  return validated({
    ...attempt,
    status: "submitted_unconfirmed",
    updatedAt: now.toISOString()
  });
}

export function blockApplicationAttempt(attempt: ApplicationAttempt, blocker: string, now = new Date()): ApplicationAttempt {
  if (attempt.status === "confirmed") {
    throw new Error("A confirmed application attempt cannot be moved to blocked");
  }
  if (!blocker.trim()) {
    throw new Error("A blocker reason is required");
  }
  return validated({
    ...attempt,
    status: "blocked",
    updatedAt: now.toISOString(),
    blocker: blocker.trim()
  });
}

export function confirmApplicationAttempt(
  attempt: ApplicationAttempt,
  proof: SubmissionProof,
  trustedCollectors: readonly TrustedCollector[],
  policy?: SubmissionProofPolicy,
  now = new Date()
): { attempt: ApplicationAttempt; proofEvaluation: SubmissionProofEvaluation } {
  assertTransition(attempt, "submitted_unconfirmed");
  const proofEvaluation = evaluateSubmissionProof(
    proof,
    trustedCollectors,
    {
      attemptId: attempt.attemptId,
      actionIntentHash: attempt.actionIntentHash,
      opportunityId: attempt.opportunityId,
      packetHash: attempt.packetHash,
      adapterId: attempt.adapterId,
      submittedAt: attempt.updatedAt,
      evaluatedAt: now.toISOString()
    },
    policy
  );
  if (proofEvaluation.status !== "confirmed") {
    throw new Error(`Submission proof is ${proofEvaluation.status}: ${proofEvaluation.reasons.join(", ")}`);
  }
  return {
    attempt: validated({
      ...attempt,
      status: "confirmed",
      updatedAt: now.toISOString(),
      proofId: proof.proofId,
      proofReceiptHash: proof.receiptHash,
      collectorId: proof.collectorId
    }),
    proofEvaluation
  };
}

export function confirmationLedgerEntry(
  attempt: ApplicationAttempt,
  proof: SubmissionProof,
  now = new Date()
): ActionLedgerEntry {
  if (
    attempt.status !== "confirmed" ||
    attempt.proofId !== proof.proofId ||
    attempt.proofReceiptHash !== proof.receiptHash ||
    attempt.collectorId !== proof.collectorId
  ) {
    throw new Error("Only a collector bound confirmed attempt can create a confirmation ledger entry");
  }
  if (!attempt.highStakesGatePassed || attempt.approvalId === null) {
    throw new Error("Confirmation ledger requires passed high stakes and approval gates");
  }
  const entry: ActionLedgerEntry = {
    actionId: createActionId(now),
    timestamp: now.toISOString(),
    mode: "/application-packet",
    opportunityId: attempt.opportunityId,
    reversibilityTag: attempt.reversibilityTag,
    evidenceGatePassed: true,
    approvalRequired: true,
    approvalReceived: true,
    highStakesGatePassed: true,
    result: "confirmed",
    confirmationEvidencePointer: `proof:${proof.proofId}:${proof.receiptHash}:${proof.collectorId}`
  };
  assertSchema("action-ledger-entry", entry);
  return entry;
}
