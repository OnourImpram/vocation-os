import { describe, expect, it } from "vitest";
import {
  createExecutionObservation,
  evaluateExecutionObservationBinding
} from "../../src/career-ops/execution-observation.js";
import { createOutboxCommand } from "../../src/career-ops/outbox.js";

function command() {
  return createOutboxCommand({
    runId: "RUN-OBSERVATION-001",
    opportunityId: "OPP-GREENHOUSE-SYNTHETIC-OBSERVATION",
    attemptId: "ATT-2026-SYNTHETIC-OBSERVATION",
    adapterId: "career-ops-local-fixture",
    actionType: "submit-ats-application",
    actionIntentHash: `sha256:${"1".repeat(64)}`,
    verificationBundleHash: `sha256:${"2".repeat(64)}`,
    packetHash: `sha256:${"3".repeat(64)}`,
    executionGrantId: "GRANT-2026-SYNTHETIC-OBSERVATION",
    targetDomain: "synthetic.example",
    documentHashes: [`sha256:${"4".repeat(64)}`],
    now: new Date("2026-08-28T08:30:00.000Z")
  });
}

function observation() {
  const outbox = command();
  return {
    outbox,
    observation: createExecutionObservation({
      command: outbox,
      planHash: `sha256:${"5".repeat(64)}`,
      status: "submitted",
      capturedAt: "2026-08-28T08:35:00.000Z",
      sourceDomain: "synthetic.example",
      targetDomain: "synthetic.example",
      referenceId: "SYN-OBSERVATION-001",
      indicators: ["application successfully submitted"],
      attachmentCount: 1,
      submittedAt: "2026-08-28T08:35:00.000Z"
    })
  };
}

describe("career execution observation binding", () => {
  it("binds the observation to the exact command, attempt, packet, grant, plan, and idempotency key", () => {
    const { outbox, observation: captured } = observation();

    expect(captured.commandId).toBe(outbox.commandId);
    expect(captured.attemptId).toBe(outbox.attemptId);
    expect(captured.actionIntentHash).toBe(outbox.actionIntentHash);
    expect(captured.verificationBundleHash).toBe(outbox.verificationBundleHash);
    expect(captured.packetHash).toBe(outbox.packetHash);
    expect(captured.executionGrantId).toBe(outbox.executionGrantId);
    expect(captured.idempotencyKey).toBe(outbox.idempotencyKey);
    expect(captured.planHash).toBe(`sha256:${"5".repeat(64)}`);
    expect(captured.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evaluateExecutionObservationBinding(captured, outbox, captured.planHash)).toEqual({
      valid: true,
      reasons: []
    });
  });

  it("rejects an observation grafted onto a different packet", () => {
    const { outbox, observation: captured } = observation();
    const tampered = { ...captured, packetHash: `sha256:${"9".repeat(64)}` };
    const result = evaluateExecutionObservationBinding(tampered, outbox, captured.planHash);

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("execution observation packet hash does not match the Outbox command");
  });

  it("rejects an observation bound to a different plan", () => {
    const { outbox, observation: captured } = observation();
    const result = evaluateExecutionObservationBinding(
      captured,
      outbox,
      `sha256:${"8".repeat(64)}`
    );

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("execution observation plan hash does not match the expected plan");
  });

  it("rejects payload tampering even when command fields still match", () => {
    const { outbox, observation: captured } = observation();
    const tampered = { ...captured, indicators: ["application failed"] };
    const result = evaluateExecutionObservationBinding(tampered, outbox, captured.planHash);

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("execution observation payload hash does not match its content");
  });
});
