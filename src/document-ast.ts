import { validateClaimGraph } from "./claim-graph.js";
import { normalizeClaimText } from "./hash.js";
import { assertSchema } from "./schema.js";
import type { Claim, ClaimGraph } from "./types.js";

export const DOCUMENT_KINDS = ["cv", "cover-letter", "outreach", "interview-story", "public-profile"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface DocumentHeadingNode {
  nodeId: string;
  type: "heading";
  level: 1 | 2 | 3;
  text: string;
  claimIds: [];
}

export interface DocumentSentenceNode {
  nodeId: string;
  type: "sentence";
  bindingMode: "verbatim-claim";
  text: string;
  claimIds: string[];
}

export type DocumentNode = DocumentHeadingNode | DocumentSentenceNode;

export interface DocumentSection {
  sectionId: string;
  label: string;
  nodes: DocumentNode[];
}

export interface DocumentAst {
  documentId: string;
  kind: DocumentKind;
  profileId: string;
  opportunityId: string | null;
  generatedAt: string;
  sections: DocumentSection[];
}

export interface DocumentValidationResult {
  valid: boolean;
  reasons: string[];
  sentenceCount: number;
  tracedSentenceCount: number;
  traceCoverage: number;
}

function claimAllowedForKind(claim: Claim, kind: DocumentKind): boolean {
  if (kind === "cv") return claim.allowedInCv;
  if (kind === "cover-letter" || kind === "outreach") return claim.allowedInOutreach;
  if (kind === "public-profile") return claim.publiclyAssertable;
  return claim.publiclyAssertable;
}

export function validateDocumentAst(
  document: DocumentAst,
  graph: ClaimGraph,
  now = new Date()
): DocumentValidationResult {
  assertSchema("document-ast", document);
  const graphValidation = validateClaimGraph(graph, { now });
  const reasons = [...graphValidation.reasons];
  if (document.profileId !== graph.profileId) reasons.push("document-profile-mismatch");
  const claimIndex = new Map(graph.claims.map((claim) => [claim.claimId, claim]));
  const nodeIds = new Set<string>();
  const sectionIds = new Set<string>();
  let sentenceCount = 0;
  let tracedSentenceCount = 0;

  for (const section of document.sections) {
    if (sectionIds.has(section.sectionId)) reasons.push(`duplicate-section:${section.sectionId}`);
    sectionIds.add(section.sectionId);
    for (const node of section.nodes) {
      if (nodeIds.has(node.nodeId)) reasons.push(`duplicate-node:${node.nodeId}`);
      nodeIds.add(node.nodeId);
      if (/[\u200b-\u200d\u2060\ufeff]/u.test(node.text)) reasons.push(`hidden-text:${node.nodeId}`);
      if (node.type === "heading") continue;
      sentenceCount += 1;
      if (node.claimIds.length > 0) tracedSentenceCount += 1;
      if (node.claimIds.length === 0) reasons.push(`untraced-sentence:${node.nodeId}`);
      if (node.claimIds.length > 1) reasons.push(`multi-claim-sentence-not-supported:${node.nodeId}`);
      for (const claimId of new Set(node.claimIds)) {
        const claim = claimIndex.get(claimId);
        if (!claim) {
          reasons.push(`missing-document-claim:${node.nodeId}:${claimId}`);
          continue;
        }
        if (claim.evidenceStatus !== "verified") reasons.push(`unverified-document-claim:${node.nodeId}:${claimId}`);
        if (!claim.publiclyAssertable) reasons.push(`private-document-claim:${node.nodeId}:${claimId}`);
        if (!claimAllowedForKind(claim, document.kind)) reasons.push(`claim-use-not-allowed:${node.nodeId}:${claimId}`);
        if (normalizeClaimText(node.text) !== normalizeClaimText(claim.text)) {
          reasons.push(`document-claim-text-mismatch:${node.nodeId}:${claimId}`);
        }
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    sentenceCount,
    tracedSentenceCount,
    traceCoverage: sentenceCount === 0 ? 1 : tracedSentenceCount / sentenceCount
  };
}

export function renderDocumentText(document: DocumentAst, graph: ClaimGraph, now = new Date()): string {
  const validation = validateDocumentAst(document, graph, now);
  if (!validation.valid) {
    throw new Error(`Document AST validation failed: ${validation.reasons.join(", ")}`);
  }
  return document.sections
    .flatMap((section) => [section.label, ...section.nodes.map((node) => node.text)])
    .join("\n")
    .trim();
}
