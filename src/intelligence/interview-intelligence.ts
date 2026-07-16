import { validateClaimGraph } from "../claim-graph.js";
import type { ClaimGraph } from "../types.js";
import {
  assertEvidenceRefs,
  intelligenceAssertion,
  roundMetric,
  uniqueEvidenceRefs,
  type IntelligenceAssertion
} from "./assertions.js";

export const INTERVIEW_COMPETENCIES = [
  "leadership",
  "collaboration",
  "problem-solving",
  "adaptability",
  "communication",
  "technical-depth",
  "ethical-judgment",
  "impact"
] as const;

export const INTERVIEW_STORY_SEGMENTS = ["situation", "task", "action", "result"] as const;
export const MOCK_INTERVIEW_CRITERIA = ["structure", "specificity", "ownership", "reflection", "relevance"] as const;

export type InterviewCompetency = (typeof INTERVIEW_COMPETENCIES)[number];
export type InterviewStorySegment = (typeof INTERVIEW_STORY_SEGMENTS)[number];
export type MockInterviewCriterion = (typeof MOCK_INTERVIEW_CRITERIA)[number];

export interface InterviewStory {
  storyId: string;
  competencies: InterviewCompetency[];
  claimIdsBySegment: Record<InterviewStorySegment, string[]>;
  sensitivity: "standard" | "sensitive";
}

export type InterviewStoryReasonCode =
  | "graph-invalid"
  | "competency-missing"
  | "segment-missing"
  | "claim-missing"
  | "claim-unverified"
  | "claim-private";

export interface InterviewStoryValidation {
  storyId: string;
  valid: boolean;
  reasonCodes: InterviewStoryReasonCode[];
  missingSegments: InterviewStorySegment[];
  invalidClaimIds: string[];
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

export interface MockInterviewCriterionRating {
  criterion: MockInterviewCriterion;
  rating: 0 | 1 | 2 | 3 | 4;
  evidenceRefs: string[];
}

export interface MockInterviewObservation {
  observationId: string;
  storyId: string;
  observedSegments: InterviewStorySegment[];
  observedClaimIds: string[];
  criterionRatings: MockInterviewCriterionRating[];
  evidenceRefs: string[];
}

export interface MockInterviewEvaluation {
  observationId: string;
  storyId: string;
  status: "invalid-story" | "review-required";
  reviewBand: "evidence-gap" | "complete-structure";
  segmentCoverage: number;
  claimCoverage: number;
  meanCriterionRating: number | null;
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

export function validateInterviewStory(
  story: InterviewStory,
  graph: ClaimGraph,
  now = new Date()
): InterviewStoryValidation {
  if (!story.storyId.trim()) throw new Error("Interview story id is required");
  const reasonCodes = new Set<InterviewStoryReasonCode>();
  const missingSegments: InterviewStorySegment[] = [];
  const invalidClaimIds = new Set<string>();
  if (story.competencies.length === 0) reasonCodes.add("competency-missing");
  if (new Set(story.competencies).size !== story.competencies.length) throw new Error("Interview story competencies must be unique");
  const graphValidation = validateClaimGraph(graph, { now });
  if (!graphValidation.valid) reasonCodes.add("graph-invalid");
  const claimIndex = new Map(graph.claims.map((claim) => [claim.claimId, claim]));
  const evidenceGroups: string[][] = [];

  for (const segment of INTERVIEW_STORY_SEGMENTS) {
    const claimIds = story.claimIdsBySegment[segment];
    if (claimIds.length === 0) {
      missingSegments.push(segment);
      reasonCodes.add("segment-missing");
    }
    if (new Set(claimIds).size !== claimIds.length) throw new Error(`Interview story ${segment} claim ids must be unique`);
    for (const claimId of claimIds) {
      const claim = claimIndex.get(claimId);
      if (!claim) {
        invalidClaimIds.add(claimId);
        reasonCodes.add("claim-missing");
        continue;
      }
      if (claim.evidenceStatus !== "verified") {
        invalidClaimIds.add(claimId);
        reasonCodes.add("claim-unverified");
      }
      if (!claim.publiclyAssertable) {
        invalidClaimIds.add(claimId);
        reasonCodes.add("claim-private");
      }
      evidenceGroups.push([claim.sourcePointer, `claim:${claim.claimId}`]);
    }
  }

  const evidenceRefs = uniqueEvidenceRefs(evidenceGroups);
  const valid = reasonCodes.size === 0;
  return {
    storyId: story.storyId,
    valid,
    reasonCodes: [...reasonCodes].sort(),
    missingSegments,
    invalidClaimIds: [...invalidClaimIds].sort(),
    evidenceRefs,
    assertions: [intelligenceAssertion(valid ? "INTERVIEW_STORY_VALID" : "INTERVIEW_STORY_INVALID", valid ? "evidence" : "policy", valid ? evidenceRefs : [])]
  };
}

export function evaluateMockInterview(
  story: InterviewStory,
  graph: ClaimGraph,
  observation: MockInterviewObservation,
  now = new Date()
): MockInterviewEvaluation {
  if (!observation.observationId.trim()) throw new Error("Mock interview observation id is required");
  if (observation.storyId !== story.storyId) throw new Error("Mock interview observation is bound to another story");
  const observationEvidence = assertEvidenceRefs(observation.evidenceRefs, `Mock interview observation ${observation.observationId}`);
  if (new Set(observation.observedSegments).size !== observation.observedSegments.length) {
    throw new Error("Mock interview observed segments must be unique");
  }
  if (new Set(observation.observedClaimIds).size !== observation.observedClaimIds.length) {
    throw new Error("Mock interview observed claim ids must be unique");
  }
  const criterionIds = observation.criterionRatings.map((rating) => rating.criterion);
  if (new Set(criterionIds).size !== criterionIds.length) throw new Error("Mock interview criteria must be unique");
  const criterionEvidence = observation.criterionRatings.map((rating) => {
    if (!Number.isInteger(rating.rating) || rating.rating < 0 || rating.rating > 4) {
      throw new Error(`Mock interview rating for ${rating.criterion} must be an integer from 0 to 4`);
    }
    return assertEvidenceRefs(rating.evidenceRefs, `Mock interview criterion ${rating.criterion}`);
  });

  const storyValidation = validateInterviewStory(story, graph, now);
  const storyClaimIds = new Set(INTERVIEW_STORY_SEGMENTS.flatMap((segment) => story.claimIdsBySegment[segment]));
  for (const claimId of observation.observedClaimIds) {
    if (!storyClaimIds.has(claimId)) throw new Error(`Mock interview claim ${claimId} is not bound to the story`);
  }
  const segmentCoverage = observation.observedSegments.length / INTERVIEW_STORY_SEGMENTS.length;
  const claimCoverage = storyClaimIds.size === 0 ? 0 : observation.observedClaimIds.length / storyClaimIds.size;
  const meanCriterionRating = observation.criterionRatings.length === 0
    ? null
    : observation.criterionRatings.reduce((sum, rating) => sum + rating.rating, 0) / observation.criterionRatings.length;
  const completeStructure = storyValidation.valid && segmentCoverage === 1 && claimCoverage === 1;
  const evidenceRefs = uniqueEvidenceRefs([storyValidation.evidenceRefs, observationEvidence, ...criterionEvidence]);
  const assertions: IntelligenceAssertion[] = [intelligenceAssertion("INTERVIEW_MOCK_REVIEW_REQUIRED", "policy")];
  assertions.push(intelligenceAssertion(
    completeStructure ? "INTERVIEW_MOCK_STRUCTURE_COMPLETE" : "INTERVIEW_MOCK_EVIDENCE_GAP",
    "calculation",
    evidenceRefs
  ));
  if (observation.criterionRatings.length > 0) {
    assertions.push(intelligenceAssertion("INTERVIEW_MOCK_CRITERIA_RECORDED", "evidence", uniqueEvidenceRefs(criterionEvidence)));
  }
  return {
    observationId: observation.observationId,
    storyId: story.storyId,
    status: storyValidation.valid ? "review-required" : "invalid-story",
    reviewBand: completeStructure ? "complete-structure" : "evidence-gap",
    segmentCoverage: roundMetric(segmentCoverage),
    claimCoverage: roundMetric(claimCoverage),
    meanCriterionRating: meanCriterionRating === null ? null : roundMetric(meanCriterionRating),
    evidenceRefs,
    assertions
  };
}
