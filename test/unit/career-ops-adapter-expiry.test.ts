import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { getShippedCareerExecutionAdapter } from "../../src/career-ops/execution-adapter.js";
import { createExecutionGrant } from "../../src/career-ops/execution-grant.js";
import {
  createOutboxCommand,
  markOutboxExecuting,
  markOutboxReady,
  reserveOutboxCommand
} from "../../src/career-ops/outbox.js";

it("rechecks grant expiry at execution time instead of reusing the planning timestamp", async () => {
  const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
  if (!adapter) throw new Error("synthetic fixture adapter is unavailable");
  const drafted = createOutboxCommand({
    runId: "RUN-GRANT-EXPIRY",
    opportunityId: "OPP-GREENHOUSE-SYNTHETIC-EXPIRY",
    attemptId: "ATT-2026-SYNTHETIC-EXPIRY",
    adapterId: "career-ops-local-fixture",
    actionType: "submit-ats-application",
    actionIntentHash: `sha256:${"1".repeat(64)}`,
    verificationBundleHash: `sha256:${"2".repeat(64)}`,
    packetHash: `sha256:${"3".repeat(64)}`,
    executionGrantId: "GRANT-2026-SYNTHETIC-EXPIRY",
    targetDomain: "synthetic.example",
    documentHashes: [`sha256:${"4".repeat(64)}`],
    now: new Date("2026-08-28T08:30:00.000Z")
  });
  const command = markOutboxExecuting(
    reserveOutboxCommand(
      markOutboxReady(drafted, new Date("2026-08-28T08:31:00.000Z")),
      "application-operator-expiry",
      new Date("2026-08-28T08:32:00.000Z")
    ),
    new Date("2026-08-28T08:33:00.000Z")
  );
  const keys = generateKeyPairSync("ed25519");
  const grant = createExecutionGrant({
    grantId: command.executionGrantId,
    approvedBy: "synthetic-operator",
    keyId: "KEY-SYNTHETIC-EXPIRY",
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
    expiresAt: "2026-08-28T09:00:00.000Z",
    approvalText: "Authorise the bounded expiry regression test."
  }, keys.privateKey);
  const authorization = {
    grant,
    trustedApprovers: [{
      approvedBy: "synthetic-operator",
      keyId: "KEY-SYNTHETIC-EXPIRY",
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString()
    }],
    expectation: {
      adapterId: command.adapterId,
      employerDomain: command.targetDomain,
      opportunityType: "job",
      actionType: command.actionType,
      requestedFields: ["name", "email", "cv"],
      fitScore: 4.8,
      legitimacyTier: "green" as const,
      totalConfirmedActions: 0,
      confirmedActionsToday: 0,
      evaluatedAt: "2026-08-28T08:34:00.000Z"
    }
  };
  const plan = await adapter.plan({
    command,
    profileScope: "synthetic",
    verificationStatus: "verified",
    legitimacyTier: "green",
    requestedFields: ["name", "email", "cv"],
    authorization,
    now: new Date("2026-08-28T08:34:00.000Z")
  });

  await expect(adapter.execute({
    command,
    plan,
    authorization,
    now: new Date("2026-08-28T09:00:00.000Z")
  })).rejects.toThrow("execution-grant-expired");
});
