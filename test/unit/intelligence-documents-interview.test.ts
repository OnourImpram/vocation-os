import { describe, expect, it } from "vitest";
import { computeClaimTextHash } from "../../src/hash.js";
import type { DocumentAstV2 } from "../../src/documents/document-ast-v2.js";
import type { DocumentRenderVerification } from "../../src/documents/document-renderer.js";
import {
  evaluateAtsDocumentMetrics,
  evaluateMockInterview,
  validateInterviewStory,
  type InterviewStory
} from "../../src/intelligence/index.js";
import { DEMO_CLAIM_TEXT, demoGraph } from "../fixtures.js";

const NOW = new Date("2026-07-14T10:00:00.000Z");

function document(): DocumentAstV2 {
  return {
    schemaVersion: 2,
    documentId: "DOC-INTELLIGENCE-001",
    kind: "cv",
    profileId: demoGraph().profileId,
    opportunityId: "OPP-DEMO-001",
    titleKey: "cv",
    locale: "en",
    generatedAt: NOW.toISOString(),
    layout: { pageSize: "A4", marginPoints: 48, bodyFontSize: 10 },
    sections: [{
      sectionId: "SEC-EXPERIENCE-001",
      labelKey: "experience",
      nodes: [{
        nodeId: "NODE-CLAIM-001",
        type: "bullet",
        bindingMode: "verbatim-claim",
        text: DEMO_CLAIM_TEXT,
        claimIds: ["CLM-DEMO-001"],
        textHash: computeClaimTextHash(DEMO_CLAIM_TEXT)
      }]
    }]
  };
}

function verification(valid = true): DocumentRenderVerification {
  const format = {
    valid,
    segmentCount: 3,
    verifiedSegments: valid ? 3 : 0,
    missingSegments: valid ? [] : ["fixed-test-mismatch"],
    extractedTextHash: valid
      ? "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      : "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  };
  return { valid, traceCoverage: 1, pdf: format, docx: { ...format } };
}

function story(): InterviewStory {
  return {
    storyId: "STORY-001",
    competencies: ["impact"],
    claimIdsBySegment: {
      situation: ["CLM-DEMO-001"],
      task: ["CLM-DEMO-001"],
      action: ["CLM-DEMO-001"],
      result: ["CLM-DEMO-001"]
    },
    sensitivity: "standard"
  };
}

describe("ATS metrics and interview evidence", () => {
  it("reports separate ATS metrics and never certifies compatibility", () => {
    const metrics = evaluateAtsDocumentMetrics(document(), demoGraph(), verification(), {
      targetId: "ATS-TARGET-001",
      requiredSections: ["experience", "skills"],
      terms: [
        { termId: "TERM-PROJECT", alternatives: ["synthetic project"], evidenceRefs: ["job://terms/project"] },
        { termId: "TERM-KUBERNETES", alternatives: ["kubernetes"], evidenceRefs: ["job://terms/kubernetes"] }
      ]
    }, NOW);
    expect(metrics).toMatchObject({
      status: "review-required",
      claimTraceCoverage: 1,
      parseBackCoverage: 1,
      requiredSectionCoverage: 0.5,
      termCoverage: 0.5,
      missingSectionKeys: ["skills"],
      missingTermIds: ["TERM-KUBERNETES"]
    });
    expect(metrics.assertions.map((assertion) => assertion.code)).toContain("ATS_REVIEW_REQUIRED");
    expect(evaluateAtsDocumentMetrics(document(), demoGraph(), verification(false), {
      targetId: "ATS-TARGET-002",
      requiredSections: [],
      terms: []
    }, NOW).status).toBe("hard-gated");
  });

  it("keeps story content claim-bound and mock evaluation review-only", () => {
    const validStory = validateInterviewStory(story(), demoGraph(), NOW);
    expect(validStory.valid).toBe(true);
    const evaluation = evaluateMockInterview(story(), demoGraph(), {
      observationId: "MOCK-001",
      storyId: "STORY-001",
      observedSegments: ["situation", "task", "action", "result"],
      observedClaimIds: ["CLM-DEMO-001"],
      criterionRatings: [{ criterion: "structure", rating: 4, evidenceRefs: ["transcript://mock/criterion"] }],
      evidenceRefs: ["transcript://mock/001"]
    }, NOW);
    expect(evaluation).toMatchObject({
      status: "review-required",
      reviewBand: "complete-structure",
      segmentCoverage: 1,
      claimCoverage: 1,
      meanCriterionRating: 4
    });

    const privateGraph = demoGraph({
      claims: [{ ...demoGraph().claims[0]!, publiclyAssertable: false }],
      validationSummary: { verifiedClaims: 1, unverifiedClaims: 0, privateClaims: 1 }
    });
    expect(validateInterviewStory(story(), privateGraph, NOW)).toMatchObject({
      valid: false,
      reasonCodes: ["claim-private"],
      invalidClaimIds: ["CLM-DEMO-001"]
    });
  });
});
