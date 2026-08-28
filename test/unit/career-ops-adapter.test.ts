import { describe, expect, it } from "vitest";
import {
  getShippedCareerExecutionAdapter,
  listShippedCareerExecutionAdapters
} from "../../src/career-ops/execution-adapter.js";
import { createOutboxCommand, markOutboxExecuting, markOutboxReady, reserveOutboxCommand } from "../../src/career-ops/outbox.js";

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
});
