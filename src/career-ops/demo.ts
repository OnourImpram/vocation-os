import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveApplicationAttempt,
  confirmApplicationAttempt,
  createApplicationAttempt,
  markSubmissionAttempted,
  type ApplicationAttempt
} from "../application-lifecycle.js";
import { createApprovalReference, type TrustedApprover } from "../approval.js";
import { validateApplicationPacket } from "../claim-graph.js";
import { computeClaimTextHash, computeFileHash, computePacketHash, sha256 } from "../hash.js";
import {
  createSubmissionProof,
  type SubmissionProofEvaluation,
  type TrustedCollector
} from "../submission-proof.js";
import {
  HIGH_STAKES_FLAGS,
  type ApplicationPacket,
  type Claim,
  type ClaimGraph,
  type HighStakesFlags
} from "../types.js";
import { getShippedCareerExecutionAdapter } from "./execution-adapter.js";
import {
  createExecutionGrant,
  evaluateExecutionGrant,
  type ExecutionGrantDecision
} from "./execution-grant.js";
import { assessLegitimacy, type LegitimacyAssessment } from "./legitimacy.js";
import {
  assertOutboxIdempotencyAvailable,
  confirmOutboxCommand,
  createOutboxCommand,
  markOutboxExecuting,
  markOutboxReady,
  markOutboxSubmitted,
  reserveOutboxCommand,
  type OutboxCommand
} from "./outbox.js";
import {
  createVerificationObservation,
  evaluateVerificationBundle,
  type OpportunityVerificationBundle
} from "./verification.js";

const ADAPTER_ID = "career-ops-local-fixture";
const TARGET_DOMAIN = "synthetic.example";
const OPPORTUNITY_ID = "OPP-GREENHOUSE-SYNTHETIC-ALPHA";

export interface CareerOpsAlphaDemoResult {
  verification: OpportunityVerificationBundle;
  legitimacy: LegitimacyAssessment;
  grantDecision: ExecutionGrantDecision;
  adapterId: string;
  outbox: OutboxCommand;
  applicationAttempt: ApplicationAttempt;
  proofEvaluation: SubmissionProofEvaluation;
  privateKeyMaterialPresent: false;
}

function allHighStakesFalse(): HighStakesFlags {
  return Object.fromEntries(HIGH_STAKES_FLAGS.map((flag) => [flag, false])) as HighStakesFlags;
}

function syntheticClaim(verifiedDate: string): Claim {
  const text = "Synthetic operator has verified research operations experience.";
  return {
    claimId: "CLM-SYNTHETIC-RESEARCH-OPERATIONS",
    text,
    canonicalTextHash: computeClaimTextHash(text),
    claimType: "employment",
    evidenceStatus: "verified",
    sourceType: "operator-supplied",
    sourcePointer: "synthetic:profile:research-operations",
    verifiedDate,
    recencyRequired: false,
    publiclyAssertable: true,
    allowedInCv: true,
    allowedInOutreach: true,
    allowedInAutoApply: true
  };
}

export async function runCareerOpsAlphaDemo(now = new Date()): Promise<CareerOpsAlphaDemoResult> {
  if (!Number.isFinite(now.getTime())) throw new Error("career operations demo time is invalid");
  const at = (seconds: number): Date => new Date(now.getTime() + seconds * 1000);
  const root = mkdtempSync(path.join(tmpdir(), "vocation-career-ops-alpha-"));

  try {
    const cvRelativePath = "synthetic-cv.txt";
    const cvPath = path.join(root, cvRelativePath);
    writeFileSync(
      cvPath,
      "Synthetic Candidate\nVerified research operations experience.\nThis fixture contains no real personal data.\n",
      "utf8"
    );
    const cvHash = computeFileHash(cvPath);
    const claim = syntheticClaim(at(-3600).toISOString().slice(0, 10));
    const graph: ClaimGraph = {
      profileId: "DEMO-CAREER-OPS-ALPHA",
      profileScope: "synthetic",
      generatedAt: at(-600).toISOString(),
      graphVersion: "1.0.0",
      claims: [claim],
      validationSummary: { verifiedClaims: 1, unverifiedClaims: 0, privateClaims: 0 }
    };
    const packet: ApplicationPacket = {
      opportunityId: OPPORTUNITY_ID,
      claims: [{
        claimId: claim.claimId,
        text: claim.text,
        sourceClaimTextHash: claim.canonicalTextHash,
        evidenceStatus: claim.evidenceStatus,
        sourcePointer: claim.sourcePointer,
        publiclyAssertable: claim.publiclyAssertable
      }],
      documents: [{ kind: "cv", path: cvRelativePath, contentHash: cvHash }],
      tosCompliant: true,
      generatedAt: at(-500).toISOString(),
      packetHash: `sha256:${"0".repeat(64)}`,
      approvalRequired: true
    };
    packet.packetHash = computePacketHash(packet);
    const packetValidation = validateApplicationPacket(packet, graph, { documentRoot: root, now: at(-400) });
    if (!packetValidation.valid) {
      throw new Error(`synthetic application packet is invalid: ${packetValidation.reasons.join(", ")}`);
    }

    const commonObservation = {
      opportunityId: OPPORTUNITY_ID,
      employer: "Synthetic Research Labs",
      roleTitle: "Research Operations Lead",
      requisitionId: "REQ-ALPHA-001",
      locationText: "Remote, European Union",
      applyUrl: "https://boards.greenhouse.io/synthetic/jobs/1001#app",
      postedAt: at(-86_400).toISOString(),
      deadlineAt: at(1_209_600).toISOString(),
      observedStatus: "live" as const,
      extractionConfidence: "high" as const
    };
    const primary = createVerificationObservation({
      ...commonObservation,
      sourceKind: "primary",
      sourceUrl: "https://boards.greenhouse.io/synthetic/jobs/1001",
      capturedAt: at(-600).toISOString(),
      sourcePayload: { status: "open", requisitionId: "REQ-ALPHA-001" }
    });
    const independent = createVerificationObservation({
      ...commonObservation,
      sourceKind: "independent",
      sourceUrl: "https://synthetic.example/careers/research-operations-lead",
      capturedAt: at(-480).toISOString(),
      sourcePayload: { currentOpening: true, requisitionId: "REQ-ALPHA-001" }
    });
    const preAction = createVerificationObservation({
      ...commonObservation,
      sourceKind: "pre-action",
      sourceUrl: "https://boards.greenhouse.io/synthetic/jobs/1001",
      capturedAt: at(-190).toISOString(),
      sourcePayload: { status: "open", actionRoute: "available" }
    });
    const verification = evaluateVerificationBundle({
      opportunityId: OPPORTUNITY_ID,
      primary,
      independent,
      preAction,
      policy: { maximumPreActionAgeSeconds: 600, bundleLifetimeSeconds: 3600 },
      evaluatedAt: at(-185).toISOString()
    });
    if (verification.status !== "verified") {
      throw new Error(`synthetic opportunity verification failed: ${verification.reasons.join(", ")}`);
    }

    const legitimacy = assessLegitimacy({
      opportunityId: OPPORTUNITY_ID,
      verification,
      observations: {
        paymentRequired: false,
        identityDocumentRequested: false,
        suspiciousContactDomain: false,
        agencyEmployerUnknown: false,
        repostCount90Days: 0,
        employerIdentityVerified: true,
        postingDateAvailable: true,
        extractionConfidence: "high"
      },
      assessedAt: at(-180).toISOString()
    });
    if (legitimacy.tier !== "green") throw new Error("synthetic opportunity legitimacy must be green");

    const approverKeys = generateKeyPairSync("ed25519");
    const trustedApprovers: TrustedApprover[] = [{
      approvedBy: "synthetic-operator",
      keyId: "KEY-SYNTHETIC-OPERATOR",
      publicKeyPem: approverKeys.publicKey.export({ type: "spki", format: "pem" }).toString()
    }];
    const grant = createExecutionGrant({
      grantId: "GRANT-2026-SYNTHETIC-ALPHA",
      approvedBy: "synthetic-operator",
      keyId: "KEY-SYNTHETIC-OPERATOR",
      allowedAdapters: [ADAPTER_ID],
      allowedEmployerDomains: [TARGET_DOMAIN],
      allowedOpportunityTypes: ["job"],
      allowedActionTypes: ["submit-ats-application"],
      allowedFields: ["name", "email", "cv"],
      forbiddenFields: ["protected-traits", "identity-document", "payment"],
      minimumFitScore: 4.5,
      allowedLegitimacyTiers: ["green"],
      maxActions: 5,
      maxActionsPerDay: 2,
      validFrom: at(-3600).toISOString(),
      expiresAt: at(3600).toISOString(),
      approvalText: "Allow one bounded synthetic alpha application journey."
    }, approverKeys.privateKey);
    const grantDecision = evaluateExecutionGrant(grant, trustedApprovers, {
      adapterId: ADAPTER_ID,
      employerDomain: TARGET_DOMAIN,
      opportunityType: "job",
      actionType: "submit-ats-application",
      requestedFields: ["name", "email", "cv"],
      fitScore: 4.8,
      legitimacyTier: legitimacy.tier,
      totalConfirmedActions: 0,
      confirmedActionsToday: 0,
      evaluatedAt: at(-175).toISOString()
    });
    if (!grantDecision.allowed) {
      throw new Error(`synthetic execution grant was blocked: ${grantDecision.reasons.join(", ")}`);
    }

    const preparedAttempt = createApplicationAttempt({
      opportunityId: OPPORTUNITY_ID,
      packetHash: packet.packetHash,
      adapterId: ADAPTER_ID,
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: allHighStakesFalse(),
      now: at(-240)
    });
    const approval = createApprovalReference({
      operation: "auto-apply",
      approvedBy: "synthetic-operator",
      keyId: "KEY-SYNTHETIC-OPERATOR",
      approvedAt: at(-230).toISOString(),
      expiresAt: at(1800).toISOString(),
      approvalTextHash: sha256("Approve the exact synthetic application packet."),
      opportunityId: OPPORTUNITY_ID,
      packetHash: packet.packetHash,
      adapterId: ADAPTER_ID,
      actionIntentHash: preparedAttempt.actionIntentHash,
      allowedFields: ["application-packet"]
    }, approverKeys.privateKey);
    const approvedAttempt = approveApplicationAttempt(preparedAttempt, approval, trustedApprovers, at(-220));

    const draftedOutbox = createOutboxCommand({
      runId: "RUN-CAREER-OPS-ALPHA",
      opportunityId: OPPORTUNITY_ID,
      attemptId: preparedAttempt.attemptId,
      adapterId: ADAPTER_ID,
      actionType: "submit-ats-application",
      actionIntentHash: preparedAttempt.actionIntentHash,
      verificationBundleHash: verification.bundleHash,
      packetHash: packet.packetHash,
      executionGrantId: grant.grantId,
      targetDomain: TARGET_DOMAIN,
      documentHashes: [cvHash],
      now: at(-210)
    });
    assertOutboxIdempotencyAvailable([], draftedOutbox);
    const executingOutbox = markOutboxExecuting(
      reserveOutboxCommand(
        markOutboxReady(draftedOutbox, at(-200)),
        "application-operator-alpha",
        at(-190)
      ),
      at(-180)
    );

    const submittedAttempt = markSubmissionAttempted(approvedAttempt, trustedApprovers, at(-170));
    const adapter = getShippedCareerExecutionAdapter(ADAPTER_ID);
    if (!adapter) throw new Error("synthetic execution adapter is not shipped");
    const plan = await adapter.plan({
      command: executingOutbox,
      profileScope: graph.profileScope,
      verificationStatus: verification.status,
      legitimacyTier: legitimacy.tier,
      requestedFields: ["name", "email", "cv"]
    });
    const planValidation = await adapter.validate(plan);
    if (!planValidation.valid) {
      throw new Error(`synthetic execution plan is invalid: ${planValidation.reasons.join(", ")}`);
    }
    await adapter.preview(plan);
    const observation = await adapter.execute({ command: executingOutbox, plan, now: at(-160) });
    const submittedOutbox = markOutboxSubmitted(executingOutbox, at(-150));

    const collectorKeys = generateKeyPairSync("ed25519");
    const proofDraft = await adapter.collect(submittedAttempt, observation);
    const proof = createSubmissionProof(proofDraft, collectorKeys.privateKey);
    const trustedCollectors: TrustedCollector[] = [{
      collectorId: proofDraft.collectorId,
      keyId: proofDraft.keyId,
      publicKeyPem: collectorKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedAdapters: [ADAPTER_ID],
      allowedSourceDomains: [TARGET_DOMAIN],
      allowedKinds: ["confirmation-page"]
    }];
    const confirmation = confirmApplicationAttempt(
      submittedAttempt,
      proof,
      trustedCollectors,
      undefined,
      at(-140)
    );
    const confirmedOutbox = confirmOutboxCommand(submittedOutbox, proof.proofId, at(-140));

    return {
      verification,
      legitimacy,
      grantDecision,
      adapterId: ADAPTER_ID,
      outbox: confirmedOutbox,
      applicationAttempt: confirmation.attempt,
      proofEvaluation: confirmation.proofEvaluation,
      privateKeyMaterialPresent: false
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
