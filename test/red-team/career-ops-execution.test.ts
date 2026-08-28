import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/hash.js";
import {
  createVerificationObservation,
  evaluateVerificationBundle,
  type VerificationObservationDraft
} from "../../src/career-ops/verification.js";
import { assessLegitimacy } from "../../src/career-ops/legitimacy.js";
import {
  createExecutionGrant,
  evaluateExecutionGrant
} from "../../src/career-ops/execution-grant.js";
import { getShippedCareerExecutionAdapter } from "../../src/career-ops/execution-adapter.js";
import {
  assertOutboxIdempotencyAvailable,
  createOutboxCommand,
  markOutboxReady
} from "../../src/career-ops/outbox.js";
import {
  createSubmissionProof,
  evaluateSubmissionProof,
  type SubmissionObservationDraft,
  type TrustedCollector
} from "../../src/submission-proof.js";

const ATTEMPT_ID = "ATT-2026-00000000-0000-4000-8000-000000000001";
const WRONG_ATTEMPT_ID = "ATT-2026-00000000-0000-4000-8000-000000000002";
const COLLECTOR_ID = "COL-RED-TEAM";
const COLLECTOR_VERSION = "0.7.0";
const COLLECTOR_KEY_ID = "KEY-REDTEAM-COLLECTOR";

const BASE: Omit<VerificationObservationDraft, "sourceKind" | "sourceUrl" | "applyUrl" | "capturedAt" | "sourcePayload"> = {
  opportunityId: "OPP-GREENHOUSE-SYNTHETIC-REDTEAM",
  employer: "Synthetic Research Labs",
  roleTitle: "Research Operations Lead",
  requisitionId: "REQ-REDTEAM",
  locationText: "Remote, European Union",
  postedAt: "2026-08-27T08:00:00.000Z",
  deadlineAt: "2026-09-10T21:00:00.000Z",
  observedStatus: "live",
  extractionConfidence: "high"
};

function observation(
  sourceKind: VerificationObservationDraft["sourceKind"],
  overrides: Partial<VerificationObservationDraft> = {}
) {
  return createVerificationObservation({
    ...BASE,
    sourceKind,
    sourceUrl: sourceKind === "independent"
      ? "https://synthetic.example/careers/research-operations-lead"
      : "https://boards.greenhouse.io/synthetic/jobs/9001",
    applyUrl: "https://boards.greenhouse.io/synthetic/jobs/9001#app",
    capturedAt: sourceKind === "primary"
      ? "2026-08-28T08:00:00.000Z"
      : sourceKind === "independent"
        ? "2026-08-28T08:02:00.000Z"
        : "2026-08-28T08:05:00.000Z",
    sourcePayload: { sourceKind, status: "open" },
    ...overrides
  });
}

function verifiedBundle(overrides: Partial<Parameters<typeof evaluateVerificationBundle>[0]> = {}) {
  return evaluateVerificationBundle({
    opportunityId: BASE.opportunityId,
    primary: observation("primary"),
    independent: observation("independent"),
    preAction: observation("pre-action"),
    policy: { maximumPreActionAgeSeconds: 600, bundleLifetimeSeconds: 3600 },
    evaluatedAt: "2026-08-28T08:06:00.000Z",
    ...overrides
  });
}

function outbox(runId: string) {
  return createOutboxCommand({
    runId,
    opportunityId: BASE.opportunityId,
    attemptId: ATTEMPT_ID,
    adapterId: "career-ops-local-fixture",
    actionType: "submit-ats-application",
    actionIntentHash: `sha256:${"1".repeat(64)}`,
    verificationBundleHash: `sha256:${"2".repeat(64)}`,
    packetHash: `sha256:${"3".repeat(64)}`,
    executionGrantId: "GRANT-2026-REDTEAM-001",
    targetDomain: "synthetic.example",
    documentHashes: [`sha256:${"4".repeat(64)}`],
    now: new Date("2026-08-28T08:30:00.000Z")
  });
}

function proofDraft(indicators: string[], referenceId: string, payload: string): SubmissionObservationDraft {
  return {
    collectorId: COLLECTOR_ID,
    collectorVersion: COLLECTOR_VERSION,
    keyId: COLLECTOR_KEY_ID,
    attemptId: ATTEMPT_ID,
    actionIntentHash: `sha256:${"5".repeat(64)}`,
    opportunityId: BASE.opportunityId,
    packetHash: `sha256:${"6".repeat(64)}`,
    adapterId: "career-ops-local-fixture",
    kind: "confirmation-page",
    capturedAt: "2026-08-28T08:35:00.000Z",
    sourceDomain: "synthetic.example",
    sourcePointer: `proof:${referenceId}`,
    indicators,
    attachmentCount: 1,
    referenceId,
    sentAt: "2026-08-28T08:35:00.000Z",
    payloadHash: sha256(payload)
  };
}

function trustedCollector(publicKeyPem: string): TrustedCollector {
  return {
    collectorId: COLLECTOR_ID,
    keyId: COLLECTOR_KEY_ID,
    publicKeyPem,
    allowedAdapters: ["career-ops-local-fixture"],
    allowedSourceDomains: ["synthetic.example"],
    allowedKinds: ["confirmation-page"]
  };
}

describe("career operations adversarial execution controls", () => {
  it("does not treat a stale pre-action observation as executable evidence", () => {
    const result = verifiedBundle({
      preAction: observation("pre-action", { capturedAt: "2026-08-28T07:00:00.000Z" })
    });
    expect(result.status).toBe("expired");
  });

  it("does not accept the primary page as independent corroboration", () => {
    const result = verifiedBundle({
      independent: observation("independent", {
        sourceUrl: "https://boards.greenhouse.io/synthetic/jobs/9001?utm_source=fake-independent"
      })
    });
    expect(result.status).toBe("rejected");
  });

  it("blocks execution when legitimacy is red", () => {
    const result = assessLegitimacy({
      opportunityId: BASE.opportunityId,
      verification: verifiedBundle(),
      observations: {
        paymentRequired: true,
        identityDocumentRequested: false,
        suspiciousContactDomain: false,
        agencyEmployerUnknown: false,
        repostCount90Days: 0,
        employerIdentityVerified: true,
        postingDateAvailable: true,
        extractionConfidence: "high"
      },
      assessedAt: "2026-08-28T08:07:00.000Z"
    });
    expect(result.tier).toBe("red");
  });

  it("rejects an expired grant and a protected field request", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const grant = createExecutionGrant({
      grantId: "GRANT-2026-REDTEAM-001",
      approvedBy: "red-team-operator",
      keyId: "KEY-REDTEAM-001",
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
      expiresAt: "2026-08-28T09:00:00.000Z",
      approvalText: "Synthetic red-team grant."
    }, privateKey);
    const trusted = [{
      approvedBy: "red-team-operator",
      keyId: "KEY-REDTEAM-001",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
    }];

    const expired = evaluateExecutionGrant(grant, trusted, {
      adapterId: "career-ops-local-fixture",
      employerDomain: "synthetic.example",
      opportunityType: "job",
      actionType: "submit-ats-application",
      requestedFields: ["name", "email", "cv"],
      fitScore: 4.8,
      legitimacyTier: "green",
      totalConfirmedActions: 0,
      confirmedActionsToday: 0,
      evaluatedAt: "2026-08-28T09:00:00.000Z"
    });
    expect(expired.blockedBy).toBe("execution-grant-expired");

    const forbidden = evaluateExecutionGrant(grant, trusted, {
      adapterId: "career-ops-local-fixture",
      employerDomain: "synthetic.example",
      opportunityType: "job",
      actionType: "submit-ats-application",
      requestedFields: ["name", "protected-traits"],
      fitScore: 4.8,
      legitimacyTier: "green",
      totalConfirmedActions: 0,
      confirmedActionsToday: 0,
      evaluatedAt: "2026-08-28T08:30:00.000Z"
    });
    expect(forbidden.blockedBy).toBe("forbidden-field-requested");
  });

  it("does not let the synthetic adapter execute a private profile", async () => {
    const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
    const result = await adapter!.inspect({
      opportunityId: BASE.opportunityId,
      profileScope: "local-private",
      targetDomain: "synthetic.example"
    });
    expect(result.blockedBy).toBe("synthetic-profile-required");
  });

  it("blocks two active commands with the same idempotency key", () => {
    const first = markOutboxReady(outbox("RUN-REDTEAM-001"), new Date("2026-08-28T08:31:00.000Z"));
    const second = outbox("RUN-REDTEAM-002");
    expect(() => assertOutboxIdempotencyAvailable([first], second)).toThrow(
      "active outbox command already owns the idempotency key"
    );
  });

  it("rejects proof bound to the wrong attempt", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const draft = proofDraft(["application successfully submitted"], "SYN-REDTEAM-001", "red-team-observation");
    const proof = createSubmissionProof(draft, privateKey);
    const evaluation = evaluateSubmissionProof(
      proof,
      [trustedCollector(publicKey.export({ type: "spki", format: "pem" }).toString())],
      {
        attemptId: WRONG_ATTEMPT_ID,
        actionIntentHash: draft.actionIntentHash,
        opportunityId: draft.opportunityId,
        packetHash: draft.packetHash,
        adapterId: draft.adapterId,
        submittedAt: "2026-08-28T08:34:00.000Z",
        evaluatedAt: "2026-08-28T08:36:00.000Z"
      }
    );
    expect(evaluation.status).toBe("rejected");
  });

  it("rejects a signed proof containing a non-completion indicator", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const draft = proofDraft(["application was not submitted"], "SYN-REDTEAM-002", "red-team-negative-observation");
    const proof = createSubmissionProof(draft, privateKey);
    const evaluation = evaluateSubmissionProof(
      proof,
      [trustedCollector(publicKey.export({ type: "spki", format: "pem" }).toString())],
      {
        attemptId: draft.attemptId,
        actionIntentHash: draft.actionIntentHash,
        opportunityId: draft.opportunityId,
        packetHash: draft.packetHash,
        adapterId: draft.adapterId,
        submittedAt: "2026-08-28T08:34:00.000Z",
        evaluatedAt: "2026-08-28T08:36:00.000Z"
      }
    );
    expect(evaluation.status).toBe("rejected");
    expect(evaluation.reasons).toContain("proof contains a non completion signal");
  });
});
