import { describe, expect, it } from "vitest";
import { createApplicationAttempt } from "../../src/application-lifecycle.js";
import {
  getShippedCareerExecutionAdapter,
  listShippedCareerExecutionAdapters
} from "../../src/career-ops/execution-adapter.js";
import { createOutboxCommand, markOutboxExecuting, markOutboxReady, reserveOutboxCommand } from "../../src/career-ops/outbox.js";
import { HIGH_STAKES_FLAGS, type HighStakesFlags } from "../../src/types.js";

function allHighStakesFalse(): HighStakesFlags {
  return Object.fromEntries(HIGH_STAKES_FLAGS.map((flag) => [flag, false])) as HighStakesFlags;
}

function executingCommand() {
  const drafted = createOutboxCommand({
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
  return markOutboxExecuting(
    reserveOutboxCommand(
      markOutboxReady(drafted, new Date("2026-08-28T08:31:00.000Z")),
      "application-operator-1",
      new Date("2026-08-28T08:32:00.000Z")
    ),
    new Date("2026-08-28T08:33:00.000Z")
  );
}

async function executedFixture() {
  const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
  if (!adapter) throw new Error("synthetic fixture adapter is unavailable");
  const command = executingCommand();
  const plan = await adapter.plan({
    command,
    profileScope: "synthetic",
    verificationStatus: "verified",
    legitimacyTier: "green",
    requestedFields: ["name", "email", "cv"]
  });
  const observation = await adapter.execute({ command, plan, now: new Date("2026-08-28T08:35:00.000Z") });
  return { adapter, command, plan, observation };
}

describe("career execution adapter contract", () => {
  it("ships only the synthetic fixture adapter in alpha 1", () => {
    expect(listShippedCareerExecutionAdapters()).toEqual(["career-ops-local-fixture"]);
    expect(getShippedCareerExecutionAdapter("official-email")).toBeNull();
  });

  it("refuses a non-synthetic profile scope", async () => {
    const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
    expect(adapter).not.toBeNull();

    const inspection = await adapter!.inspect({
      opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
      profileScope: "local-private",
      targetDomain: "synthetic.example"
    });

    expect(inspection.allowed).toBe(false);
    expect(inspection.blockedBy).toBe("synthetic-profile-required");
  });

  it("refuses an external target domain", async () => {
    const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
    const inspection = await adapter!.inspect({
      opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
      profileScope: "synthetic",
      targetDomain: "example.com"
    });

    expect(inspection.allowed).toBe(false);
    expect(inspection.blockedBy).toBe("target-domain-not-supported");
  });

  it("plans, validates, previews, and executes a verified synthetic command", async () => {
    const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
    const command = executingCommand();
    const plan = await adapter!.plan({
      command,
      profileScope: "synthetic",
      verificationStatus: "verified",
      legitimacyTier: "green",
      requestedFields: ["name", "email", "cv"]
    });
    const validation = await adapter!.validate(plan);
    const preview = await adapter!.preview(plan);
    const observation = await adapter!.execute({ command, plan });

    expect(validation.valid).toBe(true);
    expect(preview.planHash).toBe(plan.planHash);
    expect(preview.targetDomain).toBe("synthetic.example");
    expect(observation.status).toBe("submitted");
    expect(observation.referenceId).toMatch(/^SYN-/);
    expect(observation.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(observation.commandId).toBe(command.commandId);
    expect(observation.attemptId).toBe(command.attemptId);
    expect(observation.actionIntentHash).toBe(command.actionIntentHash);
    expect(observation.packetHash).toBe(command.packetHash);
    expect(observation.executionGrantId).toBe(command.executionGrantId);
    expect(observation.idempotencyKey).toBe(command.idempotencyKey);
    expect(observation.planHash).toBe(plan.planHash);
  });

  it("rejects planning when the verification bundle is not current", async () => {
    const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");

    await expect(adapter!.plan({
      command: executingCommand(),
      profileScope: "synthetic",
      verificationStatus: "expired",
      legitimacyTier: "green",
      requestedFields: ["name", "email", "cv"]
    })).rejects.toThrow("verification must be current before adapter planning");
  });

  it("does not graft a valid execution observation onto another application attempt", async () => {
    const { adapter, command, observation } = await executedFixture();
    const differentAttempt = createApplicationAttempt({
      opportunityId: command.opportunityId,
      packetHash: command.packetHash,
      adapterId: command.adapterId,
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: allHighStakesFalse(),
      now: new Date("2026-08-28T08:34:00.000Z")
    });

    await expect(adapter.collect(differentAttempt, observation)).rejects.toThrow(
      "local fixture observation is bound to a different application attempt"
    );
  });

  it("reconciliation rejects a tampered execution observation", async () => {
    const { adapter, command, plan, observation } = await executedFixture();
    const result = await adapter.reconcile({
      command,
      planHash: plan.planHash,
      observation: { ...observation, packetHash: `sha256:${"9".repeat(64)}` }
    });

    expect(result.status).toBe("not-confirmed");
    expect(result.reasons).toContain("execution observation packet hash does not match the Outbox command");
    expect(result.reasons).toContain("execution observation payload hash does not match its content");
  });
});
