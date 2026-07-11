import { assertSchema } from "./schema.js";
import type { ApplicationPacket, Claim, ClaimGraph, RecencyPolicyId } from "./types.js";
import { computeClaimTextHash, computeFileHash, computePacketHash, normalizeClaimText } from "./hash.js";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface PacketValidationResult {
  valid: boolean;
  reasons: string[];
}

export interface PacketValidationOptions {
  documentRoot?: string;
  now?: Date;
}

export const RECENCY_POLICY_MAX_AGE_DAYS: Record<RecencyPolicyId, number> = {
  "job-liveness": 3,
  "salary-market": 30,
  "legal-regulatory": 30,
  "organization-contact": 90,
  "credential-status": 365
};

function indexClaims(graph: ClaimGraph): Map<string, Claim> {
  return new Map(graph.claims.map((claim) => [claim.claimId, claim]));
}

function validateRecency(claim: Claim, now: Date): string[] {
  if (!claim.recencyRequired) {
    return [];
  }
  if (claim.evidenceStatus !== "verified") {
    return [`current-source-required:${claim.claimId}`];
  }
  if (!claim.verifiedDate) {
    return [`verified-claim-missing-date:${claim.claimId}`];
  }
  if (!claim.recencyPolicyId) {
    return [`recency-policy-missing:${claim.claimId}`];
  }
  const verifiedAt = Date.parse(`${claim.verifiedDate}T00:00:00.000Z`);
  if (!Number.isFinite(verifiedAt)) {
    return [`verified-date-invalid:${claim.claimId}`];
  }
  const ageDays = (now.getTime() - verifiedAt) / 86_400_000;
  if (ageDays < -1) {
    return [`verified-date-in-future:${claim.claimId}`];
  }
  if (ageDays > RECENCY_POLICY_MAX_AGE_DAYS[claim.recencyPolicyId]) {
    return [`stale-evidence:${claim.claimId}:${claim.recencyPolicyId}`];
  }
  return [];
}

export function validateClaimGraph(graph: ClaimGraph, options: Pick<PacketValidationOptions, "now"> = {}): PacketValidationResult {
  assertSchema("claim-graph", graph);
  const ids = new Set<string>();
  const reasons: string[] = [];
  let verifiedClaims = 0;
  let unverifiedClaims = 0;
  let privateClaims = 0;
  const now = options.now ?? new Date();

  for (const claim of graph.claims) {
    if (ids.has(claim.claimId)) {
      reasons.push(`duplicate-claim:${claim.claimId}`);
    }
    ids.add(claim.claimId);

    if (claim.canonicalTextHash !== computeClaimTextHash(claim.text)) {
      reasons.push(`claim-canonical-hash-mismatch:${claim.claimId}`);
    }
    if (claim.evidenceStatus === "verified") {
      verifiedClaims += 1;
      if (!claim.verifiedDate) {
        reasons.push(`verified-claim-missing-date:${claim.claimId}`);
      }
    } else {
      unverifiedClaims += 1;
    }
    if (!claim.publiclyAssertable) {
      privateClaims += 1;
    }
    reasons.push(...validateRecency(claim, now));
  }

  if (graph.validationSummary.verifiedClaims !== verifiedClaims) {
    reasons.push("validation-summary-verified-count-mismatch");
  }
  if (graph.validationSummary.unverifiedClaims !== unverifiedClaims) {
    reasons.push("validation-summary-unverified-count-mismatch");
  }
  if (graph.validationSummary.privateClaims !== privateClaims) {
    reasons.push("validation-summary-private-count-mismatch");
  }

  return {
    valid: reasons.length === 0,
    reasons
  };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateDocument(
  document: ApplicationPacket["documents"][number],
  documentRoot: string | undefined
): string[] {
  if (!document.path) {
    return [`document-path-missing:${document.kind}`];
  }
  if (!documentRoot) {
    return [`document-root-required:${document.kind}`];
  }
  const resolvedRoot = path.resolve(documentRoot);
  const candidate = path.isAbsolute(document.path) ? path.resolve(document.path) : path.resolve(resolvedRoot, document.path);
  if (!isWithinRoot(resolvedRoot, candidate)) {
    return [`document-outside-root:${document.kind}`];
  }
  if (!existsSync(candidate)) {
    return [`document-not-found:${document.kind}`];
  }
  const realRoot = realpathSync(resolvedRoot);
  const realCandidate = realpathSync(candidate);
  if (!isWithinRoot(realRoot, realCandidate)) {
    return [`document-outside-root:${document.kind}`];
  }
  if (!statSync(realCandidate).isFile()) {
    return [`document-not-file:${document.kind}`];
  }
  if (computeFileHash(realCandidate) !== document.contentHash) {
    return [`document-hash-mismatch:${document.kind}`];
  }
  return [];
}

export function validateApplicationPacket(
  packet: ApplicationPacket,
  graph: ClaimGraph,
  options: PacketValidationOptions = {}
): PacketValidationResult {
  assertSchema("application-packet", packet);
  const graphValidation = validateClaimGraph(graph, options);
  const reasons = [...graphValidation.reasons];
  const claimIndex = indexClaims(graph);
  const packetClaimIds = new Set<string>();

  if (computePacketHash(packet) !== packet.packetHash) {
    reasons.push("packet-hash-mismatch");
  }

  if (!packet.tosCompliant) {
    reasons.push("tos-not-compliant");
  }

  for (const packetClaim of packet.claims) {
    if (packetClaimIds.has(packetClaim.claimId)) {
      reasons.push(`duplicate-packet-claim:${packetClaim.claimId}`);
    }
    packetClaimIds.add(packetClaim.claimId);

    const graphClaim = claimIndex.get(packetClaim.claimId);
    if (!graphClaim) {
      reasons.push(`missing-claim:${packetClaim.claimId}`);
      continue;
    }
    if (normalizeClaimText(packetClaim.text) !== normalizeClaimText(graphClaim.text)) {
      reasons.push(`claim-text-mismatch:${packetClaim.claimId}`);
    }
    if (packetClaim.sourceClaimTextHash !== graphClaim.canonicalTextHash || packetClaim.sourceClaimTextHash !== computeClaimTextHash(graphClaim.text)) {
      reasons.push(`claim-text-mismatch:${packetClaim.claimId}`);
    }
    if (packetClaim.evidenceStatus !== "verified" || graphClaim.evidenceStatus !== "verified") {
      reasons.push(`packet-evidence-not-verified:${packetClaim.claimId}`);
    }
    if (!packetClaim.publiclyAssertable || !graphClaim.publiclyAssertable) {
      reasons.push(`claim-not-publicly-assertable:${packetClaim.claimId}`);
    }
    if (!graphClaim.allowedInAutoApply) {
      reasons.push(`claim-not-allowed-in-auto-apply:${packetClaim.claimId}`);
    }
    if (packetClaim.sourcePointer !== graphClaim.sourcePointer) {
      reasons.push(`claim-source-mismatch:${packetClaim.claimId}`);
    }
  }

  for (const document of packet.documents) {
    reasons.push(...validateDocument(document, options.documentRoot));
  }

  return {
    valid: reasons.length === 0,
    reasons
  };
}

export function validatePublicClaims(graph: ClaimGraph): PacketValidationResult {
  const reasons = graph.claims
    .filter((claim) => !claim.publiclyAssertable)
    .map((claim) => `claim-not-publicly-assertable:${claim.claimId}`);
  return {
    valid: reasons.length === 0,
    reasons
  };
}
