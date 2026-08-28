import { describe, expect, it } from "vitest";
import {
  assertOutboxIdempotencyAvailable,
  confirmOutboxCommand,
  createOutboxCommand,
  failOutboxCommand,
  markOutboxExecuting,
  markOutboxReady,
  markOutboxSubmitted,
  reserveOutboxCommand,
  suppressOutboxCommand
} from "../../src/career-ops/outbox.js";

function command() {
  return createOutboxCommand({
    runId: "RUN-SYNTHETIC-001",
    opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
    attemptId: "ATT-2026-SYNTHETIC-001",
    adapterId: "career-ops-local-fixture",
    actionType: "submit-ats-application",
    actionIntentHash: `sha256:${"1".repeat(64)}`,
    verificationBundleHash: `sha256:${"2".repeat(64)}`,
    packetHash: `sha256:${"3".repeat(64)}`,
    executionGrantId: "GRANT-2026-SYNTHETIC-001",
    targetDomain: "synthetic.example",
    documentHashes: [`sha256:${"4".repeat(64)}`],
    now: new Date("2026-08-28T08:30:00.000Z")
  });
}

describe("career operations transactional outbox", () => {
  it("creates a stable idempotency key for the same external action", () => {
    const first = command();
    const second = createOutboxCommand({
      runId: "RUN-SYNTHETIC-002",
      opportunityId: first.opportunityId,
      attemptId: first.attemptId,
      adapterId: first.adapterId,
      actionType: first.actionType,
      actionIntentHash: first.actionIntentHash,
      verificationBundleHash: first.verificationBundleHash,
      packetHash: first.packetHash,
      executionGrantId: first.executionGrantId,
      targetDomain: first.targetDomain,
      documentHashes: [...first.documentHashes],
      now: new Date("2026-08-28T08:31:00.000Z")
    });

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.commandId).not.toBe(first.commandId);
  });

  it("moves through the only valid successful transition path", () => {
    const ready = markOutboxReady(command(), new Date("2026-08-28T08:31:00.000Z"));
    const reserved = reserveOutboxCommand(ready, "application-operator-1", new Date("2026-08-28T08:32:00.000Z"));
    const executing = markOutboxExecuting(reserved, new Date("2026-08-28T08:33:00.000Z"));
    const submitted = markOutboxSubmitted(executing, new Date("2026-08-28T08:34:00.000Z"));
    const confirmed = confirmOutboxCommand(submitted, "PRF-SYNTHETIC-001", new Date("2026-08-28T08:35:00.000Z"));

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.proofId).toBe("PRF-SYNTHETIC-001");
    expect(confirmed.reservedBy).toBe("application-operator-1");
  });

  it("rejects confirmation before the external action was attempted", () => {
    const ready = markOutboxReady(command(), new Date("2026-08-28T08:31:00.000Z"));
    const reserved = reserveOutboxCommand(ready, "application-operator-1", new Date("2026-08-28T08:32:00.000Z"));

    expect(() => confirmOutboxCommand(reserved, "PRF-SYNTHETIC-001", new Date())).toThrow(
      "must be submitted_unconfirmed"
    );
  });

  it("rejects a second reservation", () => {
    const ready = markOutboxReady(command(), new Date("2026-08-28T08:31:00.000Z"));
    const reserved = reserveOutboxCommand(ready, "application-operator-1", new Date("2026-08-28T08:32:00.000Z"));

    expect(() => reserveOutboxCommand(reserved, "application-operator-2", new Date())).toThrow(
      "must be ready"
    );
  });

  it("makes confirmed commands terminal", () => {
    const ready = markOutboxReady(command(), new Date("2026-08-28T08:31:00.000Z"));
    const reserved = reserveOutboxCommand(ready, "application-operator-1", new Date("2026-08-28T08:32:00.000Z"));
    const executing = markOutboxExecuting(reserved, new Date("2026-08-28T08:33:00.000Z"));
    const submitted = markOutboxSubmitted(executing, new Date("2026-08-28T08:34:00.000Z"));
    const confirmed = confirmOutboxCommand(submitted, "PRF-SYNTHETIC-001", new Date("2026-08-28T08:35:00.000Z"));

    expect(() => failOutboxCommand(confirmed, "late failure", new Date())).toThrow(
      "confirmed outbox command is terminal"
    );
  });

  it("requires a bounded blocker for failure", () => {
    expect(() => failOutboxCommand(command(), "   ", new Date())).toThrow("outbox blocker is required");
  });

  it("suppresses a command without allowing later execution", () => {
    const suppressed = suppressOutboxCommand(command(), "recipient opted out", new Date("2026-08-28T08:31:00.000Z"));

    expect(suppressed.status).toBe("suppressed");
    expect(() => markOutboxReady(suppressed, new Date())).toThrow("must be drafted");
  });

  it("requires reconciliation before a failed idempotency key can be reused", () => {
    const original = failOutboxCommand(
      command(),
      "transport result is ambiguous",
      new Date("2026-08-28T08:31:00.000Z")
    );
    const duplicate = command();

    expect(() => assertOutboxIdempotencyAvailable([original], duplicate)).toThrow(
      "failed outbox command requires reconciliation before idempotency key reuse"
    );
  });

  it("preserves suppression across runs for the same semantic action", () => {
    const original = suppressOutboxCommand(
      command(),
      "recipient opted out",
      new Date("2026-08-28T08:31:00.000Z")
    );
    const duplicate = command();

    expect(() => assertOutboxIdempotencyAvailable([original], duplicate)).toThrow(
      "suppressed outbox command blocks idempotency key reuse"
    );
  });

  it("does not allow a confirmed semantic action to be recreated", () => {
    const ready = markOutboxReady(command(), new Date("2026-08-28T08:31:00.000Z"));
    const reserved = reserveOutboxCommand(ready, "application-operator-1", new Date("2026-08-28T08:32:00.000Z"));
    const executing = markOutboxExecuting(reserved, new Date("2026-08-28T08:33:00.000Z"));
    const submitted = markOutboxSubmitted(executing, new Date("2026-08-28T08:34:00.000Z"));
    const confirmed = confirmOutboxCommand(submitted, "PRF-SYNTHETIC-001", new Date("2026-08-28T08:35:00.000Z"));
    const duplicate = command();

    expect(() => assertOutboxIdempotencyAvailable([confirmed], duplicate)).toThrow(
      "confirmed outbox command already owns the idempotency key"
    );
  });
});
