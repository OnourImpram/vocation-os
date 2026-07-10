import { randomUUID } from "node:crypto";
import { createActionId } from "./action-ledger.js";
import { assertSchema } from "./schema.js";
import {
  evaluateSubmissionProof,
  type SubmissionProof,
  type SubmissionProofEvaluation,
  type SubmissionProofPolicy
} from "./submission-proof.js";
import type { ActionLedgerEntry, ApprovalReference } from "./types.js";

export const APPLICATION_CHANNELS = ["ats-form", "official-email", "platform-profile", "other"] as const;
export const APPLICATION_ATTEMPT_STATUSES = ["prepared", "approved", "submitted_unconfirmed", "confirmed", "blocked"] as const;

export type ApplicationChannel = (typeof APPLICATION_CHANNELS)[number];
export type ApplicationAttemptStatus = (typeof APPLICATION_ATTEMPT_STATUSES)[number];

export interface ApplicationAttempt {
  attemptId: string;
  opportunityId: string;
  packetHash: string;
  channel: ApplicationChannel;
  status: ApplicationAttemptStatus;
  createdAt: string;
  updatedAt: string;
  approvalId: string | null;
  proofId: string | null;
  blocker: string | null;
}

export interface ApplicationAttemptInput {
  opportunityId: string;
  packetHash: string;
  channel: ApplicationChannel;
  now?: Date | undefined;
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

function assertApprovalReference(approval: ApprovalReference): void {
  if (!/^APR-[A-Z0-9-]+$/.test(approval.approvalId)) {
    throw new Error("Approval id must use the APR- identifier format");
  }
  if (!approval.approvedBy.trim()) {
    throw new Error("Approval must identify the approving operator");
  }
  if (Number.isNaN(Date.parse(approval.approvedAt))) {
    throw new Error("Approval timestamp must be a valid date-time");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(approval.approvalTextHash)) {
    throw new Error("Approval text hash must be a sha256 digest");
  }
}

export function createApplicationAttempt(input: ApplicationAttemptInput): ApplicationAttempt {
  const now = input.now ?? new Date();
  return validated({
    attemptId: `ATT-${now.getUTCFullYear()}-${randomUUID()}`,
    opportunityId: input.opportunityId,
    packetHash: input.packetHash,
    channel: input.channel,
    status: "prepared",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    approvalId: null,
    proofId: null,
    blocker: null
  });
}

export function approveApplicationAttempt(attempt: ApplicationAttempt, approval: ApprovalReference, now = new Date()): ApplicationAttempt {
  assertTransition(attempt, "prepared");
  assertApprovalReference(approval);
  return validated({
    ...attempt,
    status: "approved",
    updatedAt: now.toISOString(),
    approvalId: approval.approvalId
  });
}

export function markSubmissionAttempted(attempt: ApplicationAttempt, now = new Date()): ApplicationAttempt {
  assertTransition(attempt, "approved");
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
  policy?: SubmissionProofPolicy,
  now = new Date()
): { attempt: ApplicationAttempt; proofEvaluation: SubmissionProofEvaluation } {
  assertTransition(attempt, "submitted_unconfirmed");
  if (attempt.opportunityId !== proof.opportunityId) {
    throw new Error("Submission proof opportunity does not match the application attempt");
  }
  const proofEvaluation = evaluateSubmissionProof(proof, policy);
  if (proofEvaluation.status !== "confirmed") {
    throw new Error(`Submission proof is ${proofEvaluation.status}: ${proofEvaluation.reasons.join(", ")}`);
  }
  const confirmed = validated({
    ...attempt,
    status: "confirmed",
    updatedAt: now.toISOString(),
    proofId: proof.proofId
  });
  return { attempt: confirmed, proofEvaluation };
}

export function confirmationLedgerEntry(attempt: ApplicationAttempt, proof: SubmissionProof, now = new Date()): ActionLedgerEntry {
  if (attempt.status !== "confirmed" || attempt.proofId !== proof.proofId) {
    throw new Error("Only a proof bound confirmed attempt can create a confirmation ledger entry");
  }
  const entry: ActionLedgerEntry = {
    actionId: createActionId(now),
    timestamp: now.toISOString(),
    mode: "/application-packet",
    opportunityId: attempt.opportunityId,
    reversibilityTag: "R3",
    evidenceGatePassed: true,
    approvalRequired: true,
    approvalReceived: attempt.approvalId !== null,
    highStakesGatePassed: true,
    result: "confirmed",
    confirmationEvidencePointer: `proof:${proof.proofId}:${proof.evidenceHash}`
  };
  assertSchema("action-ledger-entry", entry);
  return entry;
}
