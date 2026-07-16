import { describe, expect, it } from "vitest";
import type { CareerTwin } from "../../src/career-twin.js";
import {
  analyzeCounterfactualRoute,
  analyzeOfferScenario,
  assessSequentialExperiment,
  createCareerTwinSnapshot,
  createReviewQueueItem,
  diffCareerTwinSnapshots,
  evaluateCampaignCandidate,
  evaluateInterviewStory,
  humanEditDistance,
  planNetworkOutreach,
  resolveReviewQueueItem,
  type CampaignPolicy
} from "../../src/intelligence/index.js";

const now = new Date("2026-07-14T10:00:00.000Z");

function twin(label = "TypeScript"): CareerTwin {
  return {
    twinId: "DEMO-TWIN-11111111-1111-4111-8111-111111111111",
    profileScope: "synthetic",
    twinVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    facts: [{
      factId: "FACT-001",
      category: "skill",
      label,
      value: label,
      validFrom: "2025-01-01T00:00:00.000Z",
      observedAt: "2026-07-01T00:00:00.000Z",
      evidenceStatus: "operator_supplied",
      sourcePointer: "demo://profile/facts/1",
      confidence: "Low",
      sensitivity: "internal",
      allowedUses: ["analysis"]
    }],
    goals: [{
      goalId: "GOAL-001",
      label: "Build decision infrastructure",
      horizon: "one-year",
      priority: 1,
      status: "active"
    }]
  };
}

function campaignPolicy(): CampaignPolicy {
  return {
    campaignId: "CAM-001",
    profileId: "DEMO-PROFILE",
    minimumFitScore: 75,
    maxActiveOpportunities: 10,
    maxNewPerDay: 3,
    maxPerCompany: 1,
    maxPerProvider: 2,
    cooldownHours: 1,
    followUpAfterDays: [7, 14],
    excludedCompanies: [],
    excludedProviders: [],
    allowedRouteTypes: ["job", "fellowship"],
    policyVersion: "campaign-policy-1"
  };
}

describe("career intelligence", () => {
  it("creates reproducible temporal snapshots and detects changed facts", () => {
    const first = createCareerTwinSnapshot(twin(), now, now);
    const second = createCareerTwinSnapshot({ ...twin("Node.js"), twinVersion: 2 }, now, new Date("2026-07-14T10:05:00.000Z"));
    expect(first.snapshotHash).toMatch(/^sha256:/);
    expect(diffCareerTwinSnapshots(first, second).changedFactIds).toEqual(["FACT-001"]);
  });

  it("blocks counterfactual routes with hard defeaters and requires evidence", () => {
    const snapshot = createCareerTwinSnapshot(twin(), now, now);
    const result = analyzeCounterfactualRoute(snapshot, {
      routeId: "ROUTE-001",
      label: "International clinical role",
      horizonMonths: 12,
      opens: ["international-practice"],
      closes: [],
      strengthenedFactIds: ["FACT-001"],
      weakenedFactIds: [],
      hardDefeaters: ["license-not-verified"],
      uncertaintyDrivers: ["work-authorization-current-source-required"],
      evidencePointers: ["demo://route/evidence/1"],
      reversibleUntil: null
    });
    expect(result.decisionStatus).toBe("blocked");
    expect(result.analysisHash).toMatch(/^sha256:/);
    expect(() => analyzeCounterfactualRoute(snapshot, {
      routeId: "ROUTE-002",
      label: "Unsupported route",
      horizonMonths: 12,
      opens: [],
      closes: [],
      strengthenedFactIds: ["FACT-MISSING"],
      weakenedFactIds: [],
      hardDefeaters: [],
      uncertaintyDrivers: [],
      evidencePointers: ["demo://route/evidence/2"],
      reversibleUntil: null
    })).toThrow(/unknown facts/);
  });

  it("never lets campaign volume override a hard gate", () => {
    const decision = evaluateCampaignCandidate(campaignPolicy(), {
      activeCount: 0,
      addedToday: 0,
      companyCounts: {},
      providerCounts: {},
      lastActionAt: null
    }, {
      opportunityId: "OPP-001",
      company: "Example",
      providerId: "greenhouse",
      routeType: "job",
      fitScore: 95,
      hardGateFailures: ["licensing-sensitive"],
      reviewReasons: []
    }, now);
    expect(decision.status).toBe("blocked");
    expect(decision.blockedBy).toContain("licensing-sensitive");
  });

  it("creates evidence-bound review queue decisions", () => {
    const item = createReviewQueueItem({
      opportunityId: "OPP-001",
      campaignId: "CAM-001",
      reasons: ["duplicate-uncertain"],
      evidencePointers: ["observation://1"],
      now
    });
    expect(resolveReviewQueueItem(item, "keep-separate").status).toBe("resolved");
  });

  it("blocks unsupported interview claims", () => {
    const result = evaluateInterviewStory({
      prompt: { promptId: "Q-1", text: "Describe impact", competency: "impact", sourcePointer: "job://1" },
      story: {
        storyId: "STORY-1",
        title: "Delivery",
        situationClaimIds: ["C-S"],
        taskClaimIds: ["C-T"],
        actionClaimIds: ["C-A"],
        resultClaimIds: ["C-R"],
        reflectionClaimIds: ["C-X"],
        permittedRoleFamilies: ["ai"]
      },
      responseClaimIds: ["C-S", "C-T", "C-A", "C-R", "C-X", "C-FABRICATED"],
      durationSeconds: 90
    });
    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaimIds).toEqual(["C-FABRICATED"]);
  });

  it("blocks network plans that lack an authoritative public source", () => {
    const result = planNetworkOutreach({
      contactId: "CONTACT-1",
      displayName: "Demo Contact",
      organization: "Example",
      relationship: "public-contact",
      source: "operator",
      sourcePointer: "operator://contact/1",
      lastContactAt: null,
      outreachCount90Days: 0
    }, now);
    expect(result.status).toBe("blocked");
  });

  it("keeps high-stakes offer estimates low confidence and asks specialist questions", () => {
    const result = analyzeOfferScenario({
      offerId: "OFFER-1",
      components: [{
        componentId: "salary",
        label: "Salary",
        annualValue: 100_000,
        currency: "USD",
        confidence: "High",
        sourcePointer: "offer://salary"
      }],
      conversionRates: {},
      targetCurrency: "USD",
      annualCostOfLiving: 40_000,
      annualTaxEstimate: null,
      highStakesFlags: ["tax liability", "work authorization"]
    });
    expect(result.confidence).toBe("Low");
    expect(result.disposableAnnualEstimate).toBeNull();
    expect(result.specialistQuestions).toHaveLength(2);
  });

  it("does not convert sequential observations into a causal claim", () => {
    const observations = [
      ["base-1", "baseline", 0, 0.2],
      ["base-2", "baseline", 1, 0.8],
      ["candidate-1", "candidate", 0, 0.4],
      ["candidate-2", "candidate", 0, 0.4]
    ] as const;
    const result = assessSequentialExperiment({
      experimentId: "EXP-001",
      approvedVariable: "document",
      baselineVariantId: "baseline",
      candidateVariantId: "candidate",
      minimumObservationsPerVariant: 2,
      maximumEce: 0.5,
      rollbackIfCandidateRateBelowBaselineBy: 0.25,
      approvalId: "APR-001"
    }, observations.map(([observationId, variantId, outcome, predictedProbability]) => ({
      observationId,
      experimentId: "EXP-001",
      opportunityId: `OPP-${observationId}`,
      variantId,
      outcome,
      predictedProbability,
      observedAt: now.toISOString(),
      evidencePointer: `outcome://${observationId}`
    })));
    expect(result.status).toBe("rollback-candidate");
    expect(result.causalClaimAllowed).toBe(false);
  });

  it("reports deterministic word-level edit distance", () => {
    expect(humanEditDistance("evidence grounded career decision", "evidence grounded decision")).toBe(1);
  });
});
