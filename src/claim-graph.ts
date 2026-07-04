import { assertSchema } from "./schema.js";
import type { ApplicationPacket, Claim, ClaimGraph } from "./types.js";
import { computeClaimTextHash, computeFileHash, computePacketHash, normalizeClaimText } from "./hash.js";
import { existsSync } from "node:fs";
import path from "node:path";

export interface PacketValidationResult {
  valid: boolean;
  reasons: string[];
}

function indexClaims(graph: ClaimGraph): Map<string, Claim> {
  return new Map(graph.claims.map((claim) => [claim.claimId, claim]));
}

export function validateClaimGraph(graph: ClaimGraph): PacketValidationResult {
  assertSchema("claim-graph", graph);
  const ids = new Set<string>();
  const reasons: string[] = [];
  let verifiedClaims = 0;
  let unverifiedClaims = 0;
  let privateClaims = 0;

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
    if (claim.recencyRequired && claim.evidenceStatus !== "verified") {
      reasons.push(`current-source-required:${claim.claimId}`);
    }
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

export function validateApplicationPacket(packet: ApplicationPacket, graph: ClaimGraph): PacketValidationResult {
  assertSchema("application-packet", packet);
  const graphValidation = validateClaimGraph(graph);
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
    if (graphClaim.recencyRequired && graphClaim.evidenceStatus !== "verified") {
      reasons.push(`current-source-required:${packetClaim.claimId}`);
    }
    if (graphClaim.evidenceStatus === "verified" && !graphClaim.verifiedDate) {
      reasons.push(`verified-claim-missing-date:${packetClaim.claimId}`);
    }
  }

  for (const document of packet.documents) {
    if (!document.path || !document.contentHash) {
      continue;
    }
    const documentPath = path.isAbsolute(document.path) ? document.path : path.resolve(process.cwd(), document.path);
    if (existsSync(documentPath) && computeFileHash(documentPath) !== document.contentHash) {
      reasons.push(`document-hash-mismatch:${document.kind}`);
    }
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
