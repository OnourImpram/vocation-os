import { normalizeClaimText } from "../hash.js";
import type { ClaimGraph } from "../types.js";
import {
  documentTextSegments,
  validateDocumentAstV2,
  type DocumentAstV2,
  type DocumentStructureKey
} from "../documents/document-ast-v2.js";
import type { DocumentRenderVerification, DocumentFormatVerification } from "../documents/document-renderer.js";
import {
  assertEvidenceRefs,
  intelligenceAssertion,
  roundMetric,
  uniqueEvidenceRefs,
  type IntelligenceAssertion
} from "./assertions.js";

export interface AtsTargetTerm {
  termId: string;
  alternatives: string[];
  evidenceRefs: string[];
}

export interface AtsValidationTarget {
  targetId: string;
  requiredSections: DocumentStructureKey[];
  terms: AtsTargetTerm[];
}

export interface AtsDocumentMetrics {
  documentId: string;
  targetId: string;
  status: "hard-gated" | "review-required";
  claimTraceCoverage: number;
  parseBackCoverage: number;
  requiredSectionCoverage: number;
  termCoverage: number;
  missingSectionKeys: DocumentStructureKey[];
  missingTermIds: string[];
  documentValidationIssueCount: number;
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

function formatCoverage(format: DocumentFormatVerification): number {
  return format.segmentCount === 0 ? 0 : format.verifiedSegments / format.segmentCount;
}

function normalizedSearchText(value: string): string {
  return normalizeClaimText(value.normalize("NFKC")).toLocaleLowerCase("en-US");
}

export function evaluateAtsDocumentMetrics(
  document: DocumentAstV2,
  graph: ClaimGraph,
  renderVerification: DocumentRenderVerification,
  target: AtsValidationTarget,
  now = new Date()
): AtsDocumentMetrics {
  if (!target.targetId.trim()) throw new Error("ATS validation target id is required");
  if (new Set(target.requiredSections).size !== target.requiredSections.length) {
    throw new Error("ATS required sections must be unique");
  }
  const termIds = target.terms.map((term) => term.termId);
  if (new Set(termIds).size !== termIds.length) throw new Error("ATS target term ids must be unique");
  const normalizedTerms = target.terms.map((term) => {
    if (!term.termId.trim()) throw new Error("ATS target term id is required");
    const alternatives = term.alternatives.map(normalizedSearchText).filter(Boolean);
    if (alternatives.length === 0) throw new Error(`ATS target term ${term.termId} requires an alternative`);
    return {
      ...term,
      alternatives,
      evidenceRefs: assertEvidenceRefs(term.evidenceRefs, `ATS target term ${term.termId}`)
    };
  });

  const validation = validateDocumentAstV2(document, graph, now);
  const documentSections = new Set(document.sections.map((section) => section.labelKey));
  const missingSectionKeys = target.requiredSections.filter((section) => !documentSections.has(section));
  const requiredSectionCoverage = target.requiredSections.length === 0
    ? 1
    : (target.requiredSections.length - missingSectionKeys.length) / target.requiredSections.length;
  const text = normalizedSearchText(documentTextSegments(document).join(" "));
  const missingTerms = normalizedTerms.filter((term) => !term.alternatives.some((alternative) => text.includes(alternative)));
  const missingTermIds = missingTerms.map((term) => term.termId).sort();
  const termCoverage = normalizedTerms.length === 0 ? 1 : (normalizedTerms.length - missingTerms.length) / normalizedTerms.length;
  const parseBackCoverage = Math.min(formatCoverage(renderVerification.pdf), formatCoverage(renderVerification.docx));
  const renderEvidenceRefs = [renderVerification.pdf.extractedTextHash, renderVerification.docx.extractedTextHash];
  const targetEvidenceRefs = uniqueEvidenceRefs(normalizedTerms.map((term) => term.evidenceRefs));
  const evidenceRefs = uniqueEvidenceRefs([renderEvidenceRefs, targetEvidenceRefs]);
  const hardGated = !validation.valid || validation.traceCoverage !== 1 || !renderVerification.valid;
  const assertions: IntelligenceAssertion[] = [];
  assertions.push(intelligenceAssertion(
    validation.valid && validation.traceCoverage === 1 ? "ATS_DOCUMENT_STRUCTURE_VALIDATED" : "ATS_DOCUMENT_INVALID",
    validation.valid && validation.traceCoverage === 1 ? "calculation" : "policy",
    validation.valid && validation.traceCoverage === 1 ? targetEvidenceRefs : []
  ));
  assertions.push(intelligenceAssertion(
    renderVerification.valid ? "ATS_PARSEBACK_VALIDATED" : "ATS_PARSEBACK_FAILED",
    "calculation",
    renderEvidenceRefs
  ));
  if (missingTermIds.length === 0) {
    assertions.push(intelligenceAssertion("ATS_REQUIRED_TERMS_COVERED", "calculation", targetEvidenceRefs));
  } else {
    assertions.push(...missingTerms.map((term) => intelligenceAssertion("ATS_REQUIRED_TERM_MISSING", "calculation", term.evidenceRefs)));
  }
  assertions.push(intelligenceAssertion("ATS_REVIEW_REQUIRED", "policy"));

  return {
    documentId: document.documentId,
    targetId: target.targetId,
    status: hardGated ? "hard-gated" : "review-required",
    claimTraceCoverage: roundMetric(validation.traceCoverage),
    parseBackCoverage: roundMetric(parseBackCoverage),
    requiredSectionCoverage: roundMetric(requiredSectionCoverage),
    termCoverage: roundMetric(termCoverage),
    missingSectionKeys,
    missingTermIds,
    documentValidationIssueCount: validation.reasons.length,
    evidenceRefs,
    assertions
  };
}
