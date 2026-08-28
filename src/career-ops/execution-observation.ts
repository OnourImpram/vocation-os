import { sha256, stableStringify } from "../hash.js";
import { assertSchema } from "../schema.js";
import type { OutboxCommand } from "./outbox.js";

export const EXECUTION_OBSERVATION_STATUSES = ["submitted", "failed", "unknown"] as const;
export type ExecutionObservationStatus = (typeof EXECUTION_OBSERVATION_STATUSES)[number];

export interface ExecutionObservation {
  adapterId: string;
  commandId: string;
  opportunityId: string;
  attemptId: string;
  actionIntentHash: string;
  verificationBundleHash: string;
  packetHash: string;
  executionGrantId: string;
  idempotencyKey: string;
  planHash: string;
  status: ExecutionObservationStatus;
  capturedAt: string;
  sourceDomain: string;
  targetDomain: string;
  referenceId: string | null;
  indicators: string[];
  attachmentCount: number;
  submittedAt: string | null;
  payloadHash: string;
}

export interface CreateExecutionObservationInput {
  command: OutboxCommand;
  planHash: string;
  status: ExecutionObservationStatus;
  capturedAt: string;
  sourceDomain: string;
  targetDomain: string;
  referenceId: string | null;
  indicators: string[];
  attachmentCount: number;
  submittedAt: string | null;
}

export interface ExecutionObservationBindingResult {
  valid: boolean;
  reasons: string[];
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z0-9.-]+$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_INDICATORS = 20;
const MAX_INDICATOR_LENGTH = 200;

function canonicalHash(value: string, label: string): string {
  const normalized = value.trim();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} must be a canonical SHA-256 value`);
  return normalized;
}

function timestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date-time`);
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value: string | null, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function domain(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function referenceId(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (!REFERENCE_PATTERN.test(normalized)) throw new Error("execution observation reference id is invalid");
  return normalized;
}

function indicators(values: string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (normalized.length > MAX_INDICATORS) {
    throw new Error(`execution observation accepts at most ${MAX_INDICATORS} indicators`);
  }
  if (normalized.some((value) => value.length > MAX_INDICATOR_LENGTH)) {
    throw new Error(`execution observation indicators must not exceed ${MAX_INDICATOR_LENGTH} characters`);
  }
  return normalized;
}

function attachmentCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("execution observation attachment count must be a non-negative integer");
  }
  return value;
}

function withoutPayloadHash(
  observation: ExecutionObservation
): Omit<ExecutionObservation, "payloadHash"> {
  const { payloadHash: _payloadHash, ...withoutHash } = observation;
  return withoutHash;
}

export function computeExecutionObservationPayloadHash(
  observation: Omit<ExecutionObservation, "payloadHash">
): string {
  return sha256(stableStringify(observation));
}

export function createExecutionObservation(input: CreateExecutionObservationInput): ExecutionObservation {
  const capturedAt = timestamp(input.capturedAt, "execution observation capture time");
  const submittedAt = optionalTimestamp(input.submittedAt, "execution observation submission time");
  const normalizedReferenceId = referenceId(input.referenceId);
  if (input.status === "submitted" && (!submittedAt || !normalizedReferenceId)) {
    throw new Error("submitted execution observations require submission time and reference id");
  }
  if (submittedAt && Date.parse(submittedAt) > Date.parse(capturedAt) + 300_000) {
    throw new Error("execution observation submission time is after the capture window");
  }

  const withoutHash: Omit<ExecutionObservation, "payloadHash"> = {
    adapterId: input.command.adapterId,
    commandId: input.command.commandId,
    opportunityId: input.command.opportunityId,
    attemptId: input.command.attemptId,
    actionIntentHash: input.command.actionIntentHash,
    verificationBundleHash: input.command.verificationBundleHash,
    packetHash: input.command.packetHash,
    executionGrantId: input.command.executionGrantId,
    idempotencyKey: input.command.idempotencyKey,
    planHash: canonicalHash(input.planHash, "execution observation plan hash"),
    status: input.status,
    capturedAt,
    sourceDomain: domain(input.sourceDomain, "execution observation source domain"),
    targetDomain: domain(input.targetDomain, "execution observation target domain"),
    referenceId: normalizedReferenceId,
    indicators: indicators(input.indicators),
    attachmentCount: attachmentCount(input.attachmentCount),
    submittedAt
  };
  const observation: ExecutionObservation = {
    ...withoutHash,
    payloadHash: computeExecutionObservationPayloadHash(withoutHash)
  };
  assertSchema("execution-observation", observation);
  return observation;
}

export function evaluateExecutionObservationBinding(
  observation: ExecutionObservation,
  command: OutboxCommand,
  expectedPlanHash: string
): ExecutionObservationBindingResult {
  const reasons: string[] = [];
  try {
    assertSchema("execution-observation", observation);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }

  if (computeExecutionObservationPayloadHash(withoutPayloadHash(observation)) !== observation.payloadHash) {
    reasons.push("execution observation payload hash does not match its content");
  }
  if (observation.adapterId !== command.adapterId) {
    reasons.push("execution observation adapter does not match the Outbox command");
  }
  if (observation.commandId !== command.commandId) {
    reasons.push("execution observation command id does not match the Outbox command");
  }
  if (observation.opportunityId !== command.opportunityId) {
    reasons.push("execution observation opportunity does not match the Outbox command");
  }
  if (observation.attemptId !== command.attemptId) {
    reasons.push("execution observation attempt id does not match the Outbox command");
  }
  if (observation.actionIntentHash !== command.actionIntentHash) {
    reasons.push("execution observation action intent does not match the Outbox command");
  }
  if (observation.verificationBundleHash !== command.verificationBundleHash) {
    reasons.push("execution observation verification bundle does not match the Outbox command");
  }
  if (observation.packetHash !== command.packetHash) {
    reasons.push("execution observation packet hash does not match the Outbox command");
  }
  if (observation.executionGrantId !== command.executionGrantId) {
    reasons.push("execution observation grant does not match the Outbox command");
  }
  if (observation.idempotencyKey !== command.idempotencyKey) {
    reasons.push("execution observation idempotency key does not match the Outbox command");
  }
  if (observation.targetDomain !== command.targetDomain) {
    reasons.push("execution observation target domain does not match the Outbox command");
  }
  let planHash: string | null = null;
  try {
    planHash = canonicalHash(expectedPlanHash, "expected execution plan hash");
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  if (planHash && observation.planHash !== planHash) {
    reasons.push("execution observation plan hash does not match the expected plan");
  }

  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}
