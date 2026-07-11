import path from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { computeActionIntentHash, computeClaimTextHash, computeFileHash, computePacketHash, sha256, stableStringify } from "../src/hash.js";
import { createApprovalReference, type TrustedApprover } from "../src/approval.js";
import { defaultAutoApplyConfig, type AutoApplyInput } from "../src/auto-apply.js";
import { EXAMPLES_DIR, PACKAGE_ROOT } from "../src/paths.js";
import { HIGH_STAKES_FLAGS, type ApplicationPacket, type ApprovalReference, type AutomationRiskSignals, type AutoApplyConfig, type ClaimGraph, type HighStakesFlags, type ReversibilityTag, type RubricDimension } from "../src/types.js";

export const DEMO_CLAIM_TEXT = "Demo operator completed a synthetic project.";

export const DEMO_DOCUMENT_PATH = path.join(EXAMPLES_DIR, "demo-profile", "source.md");
export const DEMO_DOCUMENT_ROOT = PACKAGE_ROOT;

export interface DemoApprovalOptions {
  packet?: ApplicationPacket;
  adapterId?: string;
  reversibilityTag?: ReversibilityTag;
  now?: Date;
}

const demoApproverKeyPair = generateKeyPairSync("ed25519");
const demoTrustedApprover: TrustedApprover = {
  approvedBy: "test-operator",
  keyId: "KEY-TEST-APPROVER-001",
  publicKeyPem: demoApproverKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
};

export function demoTrustedApprovers(): readonly TrustedApprover[] {
  return [demoTrustedApprover];
}

export function demoApprovalReference(options: DemoApprovalOptions = {}): ApprovalReference {
  const packet = options.packet ?? demoPacket();
  const adapterId = options.adapterId ?? "local-fixture";
  const reversibilityTag = options.reversibilityTag ?? "R3";
  const now = options.now ?? new Date();
  const approvedAt = new Date(now.getTime() - 60_000);
  const expiresAt = new Date(now.getTime() + 3_600_000);
  return createApprovalReference({
    approvalId: "APR-TEST-001",
    operation: "auto-apply",
    approvedBy: demoTrustedApprover.approvedBy,
    keyId: demoTrustedApprover.keyId,
    approvedAt: approvedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    approvalTextHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    opportunityId: packet.opportunityId,
    packetHash: packet.packetHash,
    adapterId,
    actionIntentHash: computeActionIntentHash({
      operation: "auto-apply",
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId,
      reversibilityTag
    }),
    allowedFields: ["application-packet"]
  }, demoApproverKeyPair.privateKey);
}

export function demoForcedScoreApproval(
  dimensions: RubricDimension[],
  opportunityId = "OPP-DEMO-001",
  now = new Date()
): ApprovalReference {
  const subjectHash = computeRubricSubjectHash(dimensions);
  return createApprovalReference({
    approvalId: "APR-TEST-FORCED-SCORE",
    operation: "forced-score",
    approvedBy: demoTrustedApprover.approvedBy,
    keyId: demoTrustedApprover.keyId,
    approvedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    approvalTextHash: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    opportunityId,
    packetHash: subjectHash,
    adapterId: "rubric",
    actionIntentHash: computeActionIntentHash({
      operation: "forced-score",
      opportunityId,
      packetHash: subjectHash,
      adapterId: "rubric",
      reversibilityTag: "R0"
    }),
    allowedFields: ["forced-score"]
  }, demoApproverKeyPair.privateKey);
}

function computeRubricSubjectHash(dimensions: RubricDimension[]): string {
  return sha256(stableStringify(dimensions));
}

export function noRiskSignals(): AutomationRiskSignals {
  return {
    captchaPresent: false,
    antiBotDetected: false,
    paymentRequired: false,
    identityCheckRequired: false,
    tosUnclear: false,
    unsupportedLicenseClaim: false,
    credentialFabricationRequested: false
  };
}

export function noHighStakesFlags(): HighStakesFlags {
  return Object.fromEntries(HIGH_STAKES_FLAGS.map((flag) => [flag, false])) as HighStakesFlags;
}

const temporaryLedgerPaths = new Set<string>();

process.on("exit", () => {
  for (const filePath of temporaryLedgerPaths) {
    try {
      unlinkSync(filePath);
    } catch {
      // The ledger may never have been created or may already be removed by its test.
    }
  }
});

export function freshLedgerPath(): string {
  const filePath = path.join(tmpdir(), `vocation-test-${process.pid}-${randomUUID()}.jsonl`);
  temporaryLedgerPaths.add(filePath);
  return filePath;
}

export function demoAutoApplyContext(): Pick<AutoApplyInput, "documentRoot" | "highStakesFlags" | "ledgerPath" | "trustedApprovers"> {
  return {
    documentRoot: DEMO_DOCUMENT_ROOT,
    highStakesFlags: noHighStakesFlags(),
    ledgerPath: freshLedgerPath(),
    trustedApprovers: demoTrustedApprovers()
  };
}

export function enabledConfig(): AutoApplyConfig {
  return {
    ...defaultAutoApplyConfig(),
    enabled: true,
    mode: "auto"
  };
}

export function demoGraph(overrides: Partial<ClaimGraph> = {}): ClaimGraph {
  const graph: ClaimGraph = {
    profileId: "DEMO-OPERATOR-001",
    profileScope: "synthetic",
    generatedAt: "2026-07-04T00:00:00.000Z",
    graphVersion: "0.2.0",
    claims: [
      {
        claimId: "CLM-DEMO-001",
        text: DEMO_CLAIM_TEXT,
        canonicalTextHash: computeClaimTextHash(DEMO_CLAIM_TEXT),
        claimType: "project",
        evidenceStatus: "verified",
        sourceType: "operator-supplied",
        sourcePointer: "examples/demo-profile/source.md#project",
        verifiedDate: "2026-07-04",
        recencyRequired: false,
        publiclyAssertable: true,
        allowedInCv: true,
        allowedInOutreach: true,
        allowedInAutoApply: true
      }
    ],
    validationSummary: {
      verifiedClaims: 1,
      unverifiedClaims: 0,
      privateClaims: 0
    }
  };
  return { ...graph, ...overrides };
}

export function demoPacket(evidenceStatus: "verified" | "unverified" = "verified", overrides: Partial<ApplicationPacket> = {}): ApplicationPacket {
  const packet: ApplicationPacket = {
    opportunityId: "OPP-DEMO-001",
    claims: [
      {
        claimId: "CLM-DEMO-001",
        text: DEMO_CLAIM_TEXT,
        sourceClaimTextHash: computeClaimTextHash(DEMO_CLAIM_TEXT),
        evidenceStatus,
        sourcePointer: "examples/demo-profile/source.md#project",
        publiclyAssertable: true
      }
    ],
    documents: [{ kind: "cv", path: DEMO_DOCUMENT_PATH, contentHash: computeFileHash(DEMO_DOCUMENT_PATH) }],
    tosCompliant: true,
    generatedAt: "2026-07-04T00:00:00.000Z",
    packetHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    approvalRequired: true,
    ...overrides
  };
  return {
    ...packet,
    packetHash: overrides.packetHash ?? computePacketHash(packet)
  };
}
