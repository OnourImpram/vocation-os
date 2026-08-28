import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createExecutionGrant,
  evaluateExecutionGrant,
  type ExecutionGrantExpectation
} from "../../src/career-ops/execution-grant.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const trustedApprovers = [{
  approvedBy: "synthetic-operator",
  keyId: "KEY-SYNTHETIC-001",
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
}];

function grant() {
  return createExecutionGrant({
    grantId: "GRANT-2026-SYNTHETIC-001",
    approvedBy: "synthetic-operator",
    keyId: "KEY-SYNTHETIC-001",
    allowedAdapters: ["career-ops-local-fixture"],
    allowedEmployerDomains: ["synthetic.example"],
    allowedOpportunityTypes: ["job"],
    allowedActionTypes: ["submit-ats-application"],
    allowedFields: ["name", "email", "cv"],
    forbiddenFields: ["protected-traits", "identity-document", "payment"],
    minimumFitScore: 4.5,
    allowedLegitimacyTiers: ["green"],
    maxActions: 5,
    maxActionsPerDay: 2,
    validFrom: "2026-08-28T08:00:00.000Z",
    expiresAt: "2026-08-29T08:00:00.000Z",
    approvalText: "Allow bounded synthetic execution for alpha validation."
  }, privateKey);
}

const EXPECTATION: ExecutionGrantExpectation = {
  adapterId: "career-ops-local-fixture",
  employerDomain: "synthetic.example",
  opportunityType: "job",
  actionType: "submit-ats-application",
  requestedFields: ["name", "email", "cv"],
  fitScore: 4.8,
  legitimacyTier: "green",
  totalConfirmedActions: 1,
  confirmedActionsToday: 0,
  evaluatedAt: "2026-08-28T08:30:00.000Z"
};

describe("career operations execution grants", () => {
  it("accepts an action inside the signed grant scope", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, EXPECTATION);

    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects a protected field even when every other constraint matches", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, {
      ...EXPECTATION,
      requestedFields: ["name", "protected-traits"]
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("forbidden-field-requested");
  });

  it("rejects an adapter that is outside the signed scope", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, {
      ...EXPECTATION,
      adapterId: "greenhouse"
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("adapter-not-granted");
  });

  it("rejects a fit score below the signed threshold", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, {
      ...EXPECTATION,
      fitScore: 4.2
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("fit-score-below-grant-threshold");
  });

  it("rejects a fit score outside the one-to-five scale", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, {
      ...EXPECTATION,
      fitScore: 6
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("execution-grant-fit-score-invalid");
  });

  it("rejects an expired grant", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, {
      ...EXPECTATION,
      evaluatedAt: "2026-08-29T08:00:00.000Z"
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("execution-grant-expired");
  });

  it("rejects daily action exhaustion", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, {
      ...EXPECTATION,
      confirmedActionsToday: 2
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("execution-grant-daily-limit-exhausted");
  });

  it("rejects inconsistent grant usage counters", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, {
      ...EXPECTATION,
      totalConfirmedActions: 0,
      confirmedActionsToday: 1
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("execution-grant-usage-invalid");
  });

  it("returns a blocked decision instead of throwing for malformed expectations", () => {
    const result = evaluateExecutionGrant(grant(), trustedApprovers, {
      ...EXPECTATION,
      adapterId: "Green House!"
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("execution-grant-expectation-invalid");
  });

  it("requires non-empty approval text before signing a grant", () => {
    expect(() => createExecutionGrant({
      grantId: "GRANT-2026-SYNTHETIC-002",
      approvedBy: "synthetic-operator",
      keyId: "KEY-SYNTHETIC-001",
      allowedAdapters: ["career-ops-local-fixture"],
      allowedEmployerDomains: ["synthetic.example"],
      allowedOpportunityTypes: ["job"],
      allowedActionTypes: ["submit-ats-application"],
      allowedFields: ["name", "email", "cv"],
      forbiddenFields: ["protected-traits", "identity-document", "payment"],
      minimumFitScore: 4.5,
      allowedLegitimacyTiers: ["green"],
      maxActions: 5,
      maxActionsPerDay: 2,
      validFrom: "2026-08-28T08:00:00.000Z",
      expiresAt: "2026-08-29T08:00:00.000Z",
      approvalText: "   "
    }, privateKey)).toThrow("execution grant approval text is required");
  });

  it("rejects a grant whose signature has been changed", () => {
    const signed = grant();
    const result = evaluateExecutionGrant({ ...signed, minimumFitScore: 1 }, trustedApprovers, EXPECTATION);

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("execution-grant-signature-invalid");
  });
});
