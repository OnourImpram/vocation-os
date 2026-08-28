import { randomUUID } from "node:crypto";
import { sha256, stableStringify } from "../hash.js";
import { assertSchema } from "../schema.js";
import type { CareerActionType } from "./execution-grant.js";

export const OUTBOX_STATUSES = [
  "drafted",
  "ready",
  "reserved",
  "executing",
  "submitted_unconfirmed",
  "confirmed",
  "failed",
  "suppressed"
] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxCommand {
  commandId: string;
  runId: string;
  opportunityId: string;
  attemptId: string;
  adapterId: string;
  actionType: CareerActionType;
  actionIntentHash: string;
  verificationBundleHash: string;
  packetHash: string;
  executionGrantId: string;
  targetDomain: string;
  documentHashes: string[];
  idempotencyKey: string;
  status: OutboxStatus;
  createdAt: string;
  updatedAt: string;
  reservedBy: string | null;
  reservedAt: string | null;
  executionStartedAt: string | null;
  blocker: string | null;
  proofId: string | null;
}

export interface CreateOutboxCommandInput {
  runId: string;
  opportunityId: string;
  attemptId: string;
  adapterId: string;
  actionType: CareerActionType;
  actionIntentHash: string;
  verificationBundleHash: string;
  packetHash: string;
  executionGrantId: string;
  targetDomain: string;
  documentHashes: string[];
  now?: Date;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z0-9.-]+$/;
const ADAPTER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function nonEmpty(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} must not exceed ${maximum} characters`);
  return normalized;
}

function canonicalHash(value: string, label: string): string {
  const normalized = value.trim();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} must be a canonical SHA-256 value`);
  return normalized;
}

function normalizedDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) throw new Error("outbox target domain is invalid");
  return normalized;
}

function normalizedAdapter(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ADAPTER_PATTERN.test(normalized)) throw new Error("outbox adapter id is invalid");
  return normalized;
}

function timestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("outbox timestamp is invalid");
  return now.toISOString();
}

function assertTransition(command: OutboxCommand, expected: OutboxStatus): void {
  if (command.status !== expected) {
    throw new Error(`outbox command ${command.commandId} must be ${expected}, found ${command.status}`);
  }
}

function validated(command: OutboxCommand): OutboxCommand {
  assertSchema("outbox-command", command);
  return command;
}

export function deriveOutboxIdempotencyKey(
  input: Omit<CreateOutboxCommandInput, "runId" | "now">
): string {
  const canonical = {
    opportunityId: nonEmpty(input.opportunityId, "opportunity id"),
    attemptId: nonEmpty(input.attemptId, "attempt id"),
    adapterId: normalizedAdapter(input.adapterId),
    actionType: input.actionType,
    actionIntentHash: canonicalHash(input.actionIntentHash, "action intent hash"),
    verificationBundleHash: canonicalHash(input.verificationBundleHash, "verification bundle hash"),
    packetHash: canonicalHash(input.packetHash, "packet hash"),
    executionGrantId: nonEmpty(input.executionGrantId, "execution grant id"),
    targetDomain: normalizedDomain(input.targetDomain),
    documentHashes: [...new Set(input.documentHashes.map((hash) => canonicalHash(hash, "document hash")))].sort()
  };
  return sha256(stableStringify(canonical));
}

export function createOutboxCommand(input: CreateOutboxCommandInput): OutboxCommand {
  const now = input.now ?? new Date();
  const createdAt = timestamp(now);
  const command: OutboxCommand = {
    commandId: `CMD-${randomUUID().toUpperCase()}`,
    runId: nonEmpty(input.runId, "run id"),
    opportunityId: nonEmpty(input.opportunityId, "opportunity id"),
    attemptId: nonEmpty(input.attemptId, "attempt id"),
    adapterId: normalizedAdapter(input.adapterId),
    actionType: input.actionType,
    actionIntentHash: canonicalHash(input.actionIntentHash, "action intent hash"),
    verificationBundleHash: canonicalHash(input.verificationBundleHash, "verification bundle hash"),
    packetHash: canonicalHash(input.packetHash, "packet hash"),
    executionGrantId: nonEmpty(input.executionGrantId, "execution grant id"),
    targetDomain: normalizedDomain(input.targetDomain),
    documentHashes: [...new Set(input.documentHashes.map((hash) => canonicalHash(hash, "document hash")))].sort(),
    idempotencyKey: deriveOutboxIdempotencyKey(input),
    status: "drafted",
    createdAt,
    updatedAt: createdAt,
    reservedBy: null,
    reservedAt: null,
    executionStartedAt: null,
    blocker: null,
    proofId: null
  };
  return validated(command);
}

function withStatus(command: OutboxCommand, status: OutboxStatus, now: Date, changes: Partial<OutboxCommand> = {}): OutboxCommand {
  const updatedAt = timestamp(now);
  if (Date.parse(updatedAt) < Date.parse(command.updatedAt)) {
    throw new Error("outbox transition time must not move backwards");
  }
  return validated({ ...command, ...changes, status, updatedAt });
}

export function markOutboxReady(command: OutboxCommand, now = new Date()): OutboxCommand {
  assertTransition(command, "drafted");
  return withStatus(command, "ready", now);
}

export function reserveOutboxCommand(command: OutboxCommand, workerId: string, now = new Date()): OutboxCommand {
  assertTransition(command, "ready");
  const reservedBy = nonEmpty(workerId, "outbox reservation worker", 160);
  const reservedAt = timestamp(now);
  return withStatus(command, "reserved", now, { reservedBy, reservedAt });
}

export function markOutboxExecuting(command: OutboxCommand, now = new Date()): OutboxCommand {
  assertTransition(command, "reserved");
  if (!command.reservedBy || !command.reservedAt) throw new Error("outbox reservation binding is incomplete");
  return withStatus(command, "executing", now, { executionStartedAt: timestamp(now) });
}

export function markOutboxSubmitted(command: OutboxCommand, now = new Date()): OutboxCommand {
  assertTransition(command, "executing");
  return withStatus(command, "submitted_unconfirmed", now);
}

export function confirmOutboxCommand(command: OutboxCommand, proofId: string, now = new Date()): OutboxCommand {
  assertTransition(command, "submitted_unconfirmed");
  return withStatus(command, "confirmed", now, { proofId: nonEmpty(proofId, "submission proof id", 160) });
}

function blocker(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("outbox blocker is required");
  if (normalized.length > 500) throw new Error("outbox blocker must not exceed 500 characters");
  return normalized;
}

export function failOutboxCommand(command: OutboxCommand, reason: string, now = new Date()): OutboxCommand {
  if (command.status === "confirmed") throw new Error("confirmed outbox command is terminal");
  if (command.status === "suppressed") throw new Error("suppressed outbox command is terminal");
  if (command.status === "failed") throw new Error("failed outbox command is terminal");
  return withStatus(command, "failed", now, { blocker: blocker(reason) });
}

export function suppressOutboxCommand(command: OutboxCommand, reason: string, now = new Date()): OutboxCommand {
  if (command.status === "confirmed") throw new Error("confirmed outbox command is terminal");
  if (command.status === "suppressed") throw new Error("suppressed outbox command is terminal");
  if (command.status === "failed") throw new Error("failed outbox command is terminal");
  return withStatus(command, "suppressed", now, { blocker: blocker(reason) });
}

export function outboxCommandIsTerminal(command: OutboxCommand): boolean {
  return command.status === "confirmed" || command.status === "failed" || command.status === "suppressed";
}
