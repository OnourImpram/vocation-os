import type { TrustedApprover } from "../approval.js";
import { sha256 } from "../hash.js";
import {
  evaluateExecutionGrant,
  type ExecutionGrant,
  type ExecutionGrantExpectation
} from "./execution-grant.js";
import type { LegitimacyTier } from "./legitimacy.js";
import type { OutboxCommand } from "./outbox.js";

export interface AdapterAuthorizationContext {
  grant: ExecutionGrant;
  trustedApprovers: readonly TrustedApprover[];
  expectation: ExecutionGrantExpectation;
}

export interface AdapterAuthorizationEvaluation {
  allowed: boolean;
  blockedBy?: string;
  reasons: string[];
  grantSignatureHash: string;
}

export interface EvaluateAdapterAuthorizationInput {
  authorization: AdapterAuthorizationContext;
  command: OutboxCommand;
  requestedFields: string[];
  legitimacyTier: LegitimacyTier;
  evaluatedAt: Date;
  expectedOpportunityType?: string;
  expectedFitScore?: number;
  expectedGrantSignatureHash?: string;
}

function normalizeFields(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function blocked(
  grantSignatureHash: string,
  blockedBy: string,
  reasons: string[]
): AdapterAuthorizationEvaluation {
  return { allowed: false, blockedBy, reasons, grantSignatureHash };
}

export function evaluateAdapterAuthorization(
  input: EvaluateAdapterAuthorizationInput
): AdapterAuthorizationEvaluation {
  const { authorization, command } = input;
  const grantSignatureHash = sha256(authorization.grant.signature);
  const expectation = authorization.expectation;

  if (!Number.isFinite(input.evaluatedAt.getTime())) {
    return blocked(
      grantSignatureHash,
      "adapter-authorization-time-invalid",
      ["adapter authorization time is invalid"]
    );
  }
  if (authorization.grant.grantId !== command.executionGrantId) {
    return blocked(
      grantSignatureHash,
      "adapter-grant-command-mismatch",
      ["execution grant id does not match the Outbox command"]
    );
  }

  const decision = evaluateExecutionGrant(
    authorization.grant,
    authorization.trustedApprovers,
    { ...authorization.expectation, evaluatedAt: input.evaluatedAt.toISOString() }
  );
  if (!decision.allowed) {
    return blocked(
      grantSignatureHash,
      decision.blockedBy ?? "execution-grant-denied",
      decision.reasons
    );
  }

  if (expectation.adapterId.trim().toLowerCase() !== command.adapterId) {
    return blocked(
      grantSignatureHash,
      "adapter-expectation-command-mismatch",
      ["grant expectation adapter does not match the Outbox command"]
    );
  }
  if (expectation.employerDomain.trim().toLowerCase() !== command.targetDomain) {
    return blocked(
      grantSignatureHash,
      "adapter-expectation-command-mismatch",
      ["grant expectation employer domain does not match the Outbox command"]
    );
  }
  if (expectation.actionType !== command.actionType) {
    return blocked(
      grantSignatureHash,
      "adapter-expectation-command-mismatch",
      ["grant expectation action type does not match the Outbox command"]
    );
  }

  const requestedFields = normalizeFields(input.requestedFields);
  const expectedFields = normalizeFields(expectation.requestedFields);
  if (!sameValues(requestedFields, expectedFields)) {
    return blocked(
      grantSignatureHash,
      "adapter-expectation-field-mismatch",
      ["grant expectation fields do not match the adapter request"]
    );
  }
  if (expectation.legitimacyTier !== input.legitimacyTier) {
    return blocked(
      grantSignatureHash,
      "adapter-expectation-legitimacy-mismatch",
      ["grant expectation legitimacy tier does not match the adapter plan"]
    );
  }
  if (input.expectedOpportunityType !== undefined && expectation.opportunityType !== input.expectedOpportunityType) {
    return blocked(
      grantSignatureHash,
      "adapter-plan-authorization-mismatch",
      ["grant expectation opportunity type does not match the execution plan"]
    );
  }
  if (input.expectedFitScore !== undefined && expectation.fitScore !== input.expectedFitScore) {
    return blocked(
      grantSignatureHash,
      "adapter-plan-authorization-mismatch",
      ["grant expectation fit score does not match the execution plan"]
    );
  }
  if (
    input.expectedGrantSignatureHash !== undefined
    && grantSignatureHash !== input.expectedGrantSignatureHash
  ) {
    return blocked(
      grantSignatureHash,
      "adapter-plan-authorization-mismatch",
      ["execution grant signature does not match the execution plan"]
    );
  }

  return { allowed: true, reasons: [], grantSignatureHash };
}
