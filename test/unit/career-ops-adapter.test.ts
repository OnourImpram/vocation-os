import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApplicationAttempt } from "../../src/application-lifecycle.js";
import {
  getShippedCareerExecutionAdapter,
  listShippedCareerExecutionAdapters,
  type AdapterAuthorizationContext
} from "../../src/career-ops/execution-adapter.js";
import { createExecutionGrant } from "../../src/career-ops/execution-grant.js";
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

function authorization(command = executingCommand()): AdapterAuthorizationContext {
  const keys = generateKeyPairSync("ed25519");
  const grant = createExecutionGrant({
    grantId: command.executionGrantId,
    approvedBy: "synthetic-operator",
    keyId: "KEY-SYNTHETIC-ADAPTER",
    allowedAdapters: [command.adapterId],
    allowedEmployerDomains: [command.targetDomain],
    allowedOpportunityTypes: ["job"],
    allowedActionTypes: [command.actionType],
    allowedFields: ["name", "email", "cv"],
    forbiddenFields: ["protected-traits", "identity-document", "payment"],
    minimumFitScore: 4.5,
    allowedLegitimacyTiers: ["green"],
    maxActions: 5,
    maxActionsPerDay: 2,
    validFrom: "2026-08-28T08:00:00.000Z",
    expiresAt: "2026-08-29T08:00:00.000Z",
    approvalText: "Authorise the synthetic adapter contract test."
  }, keys.privateKey);
  return {
    grant,
    trustedApprovers: [{
      approvedBy: "synthetic-operator",
      keyId: "KEY-SYNTHETIC-ADAPTER",
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString()
    }],
    expectation: {
      adapterId: command.adapterId,
      employerDomain: command.targetDomain,
      opportunityType: "job",
      actionType: command.actionType,
      requestedFields: ["name", "email", "cv"],
      fitScore: 4.8,
      legitimacyTier: "green",
      totalConfirmedActions: 0,
      confirmedActionsToday: 0,
      evaluatedAt: "2026-08-28T08:34:00.000Z"
    }
  };
}

async function plannedFixture() {
  const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
  if (!adapter) throw new Error("synthetic fixture adapter is unavailable");
  const command = executingCommand();
  const auth = authorization(command);
  const plan = await adapter.plan({
    command,
    profileScope: "synthetic",
    verificationStatus: "verified",
    legitimacyTier: "green",
    requestedFields: ["name", "email", "cv"],
    authorization: auth
  });
  return { adapter, command, authorization: auth, plan };
}

async function executedFixture() {
  const planned = await plannedFixture();
  const observation = await planned.adapter.execute({
    command: planned.command,
    plan: planned.plan,
    authorization: planned.authorization,
    now: new Date("2026-08-28T08:35:00.000Z")
  });
  return { ...planned, observation };
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

  it("plans, validates, previews, and executes a verified and authorised synthetic command", async () => {
    const { adapter, command, authorization: auth, plan } = await plannedFixture();
    const validation = await adapter.validate(plan);
    const preview = await adapter.preview(plan);
    const observation = await adapter.execute({ command, plan, authorization: auth });

    expect(validation.valid).toBe(true);
    expect(preview.planHash).toBe(plan.planHash);
    expect(preview.targetDomain).toBe("synthetic.example");
    expect(plan.executionGrantId).toBe(command.executionGrantId);
    expect(plan.grantSignatureHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.fitScore).toBe(4.8);
    expect(plan.opportunityType).toBe("job");
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
    const command = executingCommand();

    await expect(adapter!.plan({
      command,
      profileScope: "synthetic",
      verificationStatus: "expired",
      legitimacyTier: "green",
      requestedFields: ["name", "email", "cv"],
      authorization: authorization(command)
    })).rejects.toThrow("verification must be current before adapter planning");
  });

  it("rejects planning when the signed grant is not trusted", async () => {
    const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
    const command = executingCommand();
    const auth = authorization(command);

    await expect(adapter!.plan({
      command,
      profileScope: "synthetic",
      verificationStatus: "verified",
      legitimacyTier: "green",
      requestedFields: ["name", "email", "cv"],
      authorization: { ...auth, trustedApprovers: [] }
    })).rejects.toThrow("execution-grant-approver-untrusted");
  });

  it("revalidates the signed grant at execution instead of trusting the plan alone", async () => {
    const { adapter, command, plan, authorization: auth } = await plannedFixture();

    await expect(adapter.execute({
      command,
      plan,
      authorization: {
        ...auth,
        expectation: { ...auth.expectation, requestedFields: ["name", "protected-traits"] }
      }
    })).rejects.toThrow("forbidden-field-requested");
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
