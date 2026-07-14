import { computeClaimTextHash, normalizeClaimText } from "../hash.js";
import { validateClaimGraph } from "../claim-graph.js";
import { assertSchema } from "../schema.js";
import type { Claim, ClaimGraph } from "../types.js";
import type { DocumentKind } from "../document-ast.js";

export const DOCUMENT_LOCALES = ["en", "en-US", "en-GB", "tr", "tr-TR"] as const;
export type DocumentLocale = (typeof DOCUMENT_LOCALES)[number];

export const DOCUMENT_STRUCTURE_KEYS = [
  "summary",
  "experience",
  "education",
  "skills",
  "projects",
  "publications",
  "credentials",
  "selected-evidence",
  "contact",
  "motivation",
  "fit",
  "closing"
] as const;
export type DocumentStructureKey = (typeof DOCUMENT_STRUCTURE_KEYS)[number];

interface DocumentVocabulary {
  titles: Readonly<Record<DocumentKind, string>>;
  structures: Readonly<Record<DocumentStructureKey, string>>;
}

const ENGLISH_VOCABULARY: DocumentVocabulary = {
  titles: {
    cv: "Curriculum Vitae",
    "cover-letter": "Cover Letter",
    outreach: "Outreach Message",
    "interview-story": "Interview Story",
    "public-profile": "Public Profile"
  },
  structures: {
    summary: "Summary",
    experience: "Experience",
    education: "Education",
    skills: "Skills",
    projects: "Projects",
    publications: "Publications",
    credentials: "Credentials",
    "selected-evidence": "Selected Evidence",
    contact: "Contact",
    motivation: "Motivation",
    fit: "Role Fit",
    closing: "Closing"
  }
};

const TURKISH_VOCABULARY: DocumentVocabulary = {
  titles: {
    cv: "Özgeçmiş",
    "cover-letter": "Ön Yazı",
    outreach: "İletişim Mesajı",
    "interview-story": "Mülakat Anlatısı",
    "public-profile": "Herkese Açık Profil"
  },
  structures: {
    summary: "Özet",
    experience: "Deneyim",
    education: "Eğitim",
    skills: "Beceriler",
    projects: "Projeler",
    publications: "Yayınlar",
    credentials: "Yetkinlik Belgeleri",
    "selected-evidence": "Seçilmiş Kanıtlar",
    contact: "İletişim",
    motivation: "Motivasyon",
    fit: "Role Uygunluk",
    closing: "Kapanış"
  }
};

const DOCUMENT_VOCABULARIES: Readonly<Record<DocumentLocale, DocumentVocabulary>> = {
  en: ENGLISH_VOCABULARY,
  "en-US": ENGLISH_VOCABULARY,
  "en-GB": ENGLISH_VOCABULARY,
  tr: TURKISH_VOCABULARY,
  "tr-TR": TURKISH_VOCABULARY
};

export interface DocumentLayoutV2 {
  pageSize: "A4" | "LETTER";
  marginPoints: number;
  bodyFontSize: number;
}

export interface DocumentHeadingNodeV2 {
  nodeId: string;
  type: "heading";
  level: 1 | 2 | 3;
  textKey: DocumentStructureKey;
  claimIds: [];
}

export interface DocumentClaimNodeV2 {
  nodeId: string;
  type: "sentence" | "bullet";
  bindingMode: "verbatim-claim";
  text: string;
  claimIds: [string];
  textHash: string;
}

export type DocumentNodeV2 = DocumentHeadingNodeV2 | DocumentClaimNodeV2;

export interface DocumentSectionV2 {
  sectionId: string;
  labelKey: DocumentStructureKey;
  nodes: DocumentNodeV2[];
}

/**
 * Renders the localized label text for a section.
 */
export function localizedSectionLabel(locale: DocumentLocale, labelKey: DocumentStructureKey): string {
  return DOCUMENT_VOCABULARIES[locale].structures[labelKey];
}

export interface DocumentAstV2 {
  schemaVersion: 2;
  documentId: string;
  kind: DocumentKind;
  profileId: string;
  opportunityId: string | null;
  titleKey: DocumentKind;
  locale: DocumentLocale;
  generatedAt: string;
  layout: DocumentLayoutV2;
  sections: DocumentSectionV2[];
}

export interface DocumentV2ValidationResult {
  valid: boolean;
  reasons: string[];
  contentNodeCount: number;
  tracedContentNodeCount: number;
  traceCoverage: number;
}

function claimAllowedForKind(claim: Claim, kind: DocumentKind): boolean {
  if (kind === "cv") return claim.allowedInCv;
  if (kind === "cover-letter" || kind === "outreach") return claim.allowedInOutreach;
  return claim.publiclyAssertable;
}

export function localizedDocumentTitle(document: DocumentAstV2): string {
  return DOCUMENT_VOCABULARIES[document.locale].titles[document.titleKey];
}

export function localizedStructureText(locale: DocumentLocale, key: DocumentStructureKey): string {
  return DOCUMENT_VOCABULARIES[locale].structures[key];
}

export function validateDocumentAstV2(
  document: DocumentAstV2,
  graph: ClaimGraph,
  now = new Date()
): DocumentV2ValidationResult {
  assertSchema("document-ast-v2", document);
  const reasons = [...validateClaimGraph(graph, { now }).reasons];
  if (document.profileId !== graph.profileId) reasons.push("document-profile-mismatch");
  if (document.titleKey !== document.kind) reasons.push("document-title-kind-mismatch");
  const claimIndex = new Map(graph.claims.map((claim) => [claim.claimId, claim]));
  const sectionIds = new Set<string>();
  const nodeIds = new Set<string>();
  let contentNodeCount = 0;
  let tracedContentNodeCount = 0;

  for (const section of document.sections) {
    if (sectionIds.has(section.sectionId)) reasons.push(`duplicate-section:${section.sectionId}`);
    sectionIds.add(section.sectionId);
    let sectionContentNodeCount = 0;
    for (const node of section.nodes) {
      if (nodeIds.has(node.nodeId)) reasons.push(`duplicate-node:${node.nodeId}`);
      nodeIds.add(node.nodeId);
      if (node.type === "heading") continue;
      const normalizedNodeText = normalizeClaimText(node.text);
      if (normalizedNodeText.length === 0) {
        reasons.push(`empty-claim-bound-content:${node.nodeId}`);
      } else {
        contentNodeCount += 1;
        sectionContentNodeCount += 1;
        if (node.claimIds.length === 1) tracedContentNodeCount += 1;
      }
      if (/[​-‍⁠﻿]/u.test(node.text)) reasons.push(`hidden-text:${node.nodeId}`);
      const claimId = node.claimIds[0];
      const claim = claimIndex.get(claimId);
      if (!claim) {
        reasons.push(`missing-document-claim:${node.nodeId}:${claimId}`);
        continue;
      }
      if (claim.evidenceStatus !== "verified") reasons.push(`unverified-document-claim:${node.nodeId}:${claimId}`);
      if (!claim.publiclyAssertable) reasons.push(`private-document-claim:${node.nodeId}:${claimId}`);
      if (!claimAllowedForKind(claim, document.kind)) reasons.push(`claim-use-not-allowed:${node.nodeId}:${claimId}`);
      if (normalizedNodeText !== normalizeClaimText(claim.text)) {
        reasons.push(`document-claim-text-mismatch:${node.nodeId}:${claimId}`);
      }
      if (node.textHash !== computeClaimTextHash(node.text) || node.textHash !== claim.canonicalTextHash) {
        reasons.push(`document-node-hash-mismatch:${node.nodeId}:${claimId}`);
      }
    }
    if (sectionContentNodeCount === 0) reasons.push(`section-claim-content-missing:${section.sectionId}`);
  }
  if (contentNodeCount === 0) reasons.push("document-content-node-missing");
  const traceCoverage = contentNodeCount === 0 ? 0 : tracedContentNodeCount / contentNodeCount;
  if (traceCoverage !== 1) reasons.push("document-trace-coverage-below-one");
  return { valid: reasons.length === 0, reasons, contentNodeCount, tracedContentNodeCount, traceCoverage };
}

export function documentTextSegments(document: DocumentAstV2): string[] {
  const segments = [localizedDocumentTitle(document)];
  for (const section of document.sections) {
    segments.push(localizedStructureText(document.locale, section.labelKey));
    for (const node of section.nodes) {
      if (node.type === "heading") {
        segments.push(localizedStructureText(document.locale, node.textKey));
      } else {
        segments.push(node.text);
      }
    }
  }
  return segments;
}
