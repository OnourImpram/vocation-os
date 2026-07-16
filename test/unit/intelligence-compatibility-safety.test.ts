import { describe, expect, it } from "vitest";
import { computeClaimTextHash } from "../../src/hash.js";
import type { DocumentAstV2 } from "../../src/documents/document-ast-v2.js";
import {
  COMPATIBILITY_OFFER_SPECIALIST_QUESTION_CODES,
  analyzeCounterfactualRoute,
  analyzeOfferScenario,
  assessSequentialExperiment,
  createCareerTwinSnapshot,
  createReviewQueueItem,
  evaluateCampaignCandidate,
  evaluateInterviewStory,
  planNetworkOutreach,
  resolveReviewQueueItem,
  snoozeReviewQueueItem,
  validateAtsDocument,
  type CampaignCandidate,
  type CampaignPolicy,
  type CareerTwinSnapshot,
  type ExperimentPolicy
} from "../../src/intelligence/index.js";
import type { CareerTwin } from "../../src/career-twin.js";
import { DEMO_CLAIM_TEXT, demoGraph } from "../fixtures.js";

const NOW = new Date("2026-07-14T10:00:00.000Z");

function policy(): CampaignPolicy {
  return {
    campaignId: "CAM-COMPAT-001",
    profileId: "DEMO-PROFILE-001",
    minimumFitScore: 75,
    maxActiveOpportunities: 5,
    maxNewPerDay: 2,
    maxPerCompany: 1,
    maxPerProvider: 2,
    cooldownHours: 2,
    followUpAfterDays: [7, 14],
    excludedCompanies: ["Excluded Inc"],
    excludedProviders: ["blocked-provider"],
    allowedRouteTypes: ["job", "consulting"],
    policyVersion: "compat-1"
  };
}

function candidate(overrides: Partial<CampaignCandidate> = {}): CampaignCandidate {
  return {
    opportunityId: "OPP-COMPAT-001",
    company: "Example Inc",
    providerId: "greenhouse",
    routeType: "job",
    fitScore: 85,
    hardGateFailures: [],
    reviewReasons: [],
    ...overrides
  };
}

function twin(): CareerTwin {
  return {
    twinId: "DEMO-TWIN-22222222-2222-4222-8222-222222222222",
    profileScope: "synthetic",
    twinVersion: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: NOW.toISOString(),
    facts: [{
      factId: "FACT-COMPAT-001",
      category: "skill",
      label: "Typed delivery",
      value: "TypeScript",
      validFrom: "2026-01-01T00:00:00.000Z",
      observedAt: NOW.toISOString(),
      evidenceStatus: "operator_supplied",
      sourcePointer: "operator://compat/fact",
      confidence: "Low",
      sensitivity: "internal",
      allowedUses: ["analysis"]
    }],
    goals: []
  };
}

function snapshot(): CareerTwinSnapshot {
  return createCareerTwinSnapshot(twin(), NOW, NOW);
}

function document(): DocumentAstV2 {
  return {
    schemaVersion: 2,
    documentId: "DOC-COMPAT-001",
    kind: "cv",
    profileId: demoGraph().profileId,
    opportunityId: null,
    titleKey: "cv",
    locale: "en",
    generatedAt: NOW.toISOString(),
    layout: { pageSize: "A4", marginPoints: 48, bodyFontSize: 10 },
    sections: [{
      sectionId: "SEC-COMPAT-001",
      labelKey: "experience",
      nodes: [{
        nodeId: "NODE-COMPAT-001",
        type: "bullet",
        bindingMode: "verbatim-claim",
        text: DEMO_CLAIM_TEXT,
        claimIds: ["CLM-DEMO-001"],
        textHash: computeClaimTextHash(DEMO_CLAIM_TEXT)
      }]
    }]
  };
}

const experimentPolicy: ExperimentPolicy = {
  experimentId: "EXP-COMPAT-001",
  approvedVariable: "document",
  baselineVariantId: "BASE",
  candidateVariantId: "CANDIDATE",
  minimumObservationsPerVariant: 2,
  maximumEce: 0.2,
  rollbackIfCandidateRateBelowBaselineBy: 0.3,
  approvalId: "APR-COMPAT-001"
};

function outcome(observationId: string, variantId: "BASE" | "CANDIDATE", value: 0 | 1, probability: number) {
  return {
    observationId,
    experimentId: experimentPolicy.experimentId,
    opportunityId: `OPP-${observationId}`,
    variantId,
    outcome: value,
    predictedProbability: probability,
    observedAt: NOW.toISOString(),
    evidencePointer: `outcome://${observationId}`
  };
}

describe("intelligence compatibility safety", () => {
  it("covers campaign eligibility, review, policy caps, and fixed hard-gate vocabulary", () => {
    const usage = { activeCount: 0, addedToday: 0, companyCounts: {}, providerCounts: {}, lastActionAt: null };
    expect(evaluateCampaignCandidate(policy(), usage, candidate(), NOW).status).toBe("eligible");
    expect(evaluateCampaignCandidate(policy(), usage, candidate({ reviewReasons: ["truth-conflict"] }), NOW).status).toBe("review");
    expect(evaluateCampaignCandidate(policy(), {
      activeCount: 5,
      addedToday: 2,
      companyCounts: { "example inc": 1 },
      providerCounts: { greenhouse: 2 },
      lastActionAt: "2026-07-14T09:00:00.000Z"
    }, candidate(), NOW).blockedBy).toEqual([
      "campaign-active-limit-exhausted",
      "campaign-company-limit-exhausted",
      "campaign-cooldown-active",
      "campaign-daily-limit-exhausted",
      "campaign-provider-limit-exhausted"
    ]);
    expect(() => evaluateCampaignCandidate(policy(), usage, candidate({
      hardGateFailures: ["freeform-unsafe"] as unknown as CampaignCandidate["hardGateFailures"]
    }), NOW)).toThrow("unsupported hard gate code");
  });

  it("keeps review queue transitions evidence-bound", () => {
    const item = createReviewQueueItem({
      opportunityId: "OPP-COMPAT-001",
      campaignId: "CAM-COMPAT-001",
      reasons: ["truth-conflict"],
      evidencePointers: ["observation://truth/1"],
      now: NOW
    });
    const snoozed = snoozeReviewQueueItem(item, "2026-07-15T10:00:00.000Z", NOW);
    expect(snoozed.status).toBe("snoozed");
    expect(resolveReviewQueueItem(snoozed, "reject")).toMatchObject({ status: "rejected", resolution: "reject" });
    expect(() => createReviewQueueItem({
      opportunityId: "OPP-COMPAT-002",
      campaignId: "CAM-COMPAT-001",
      reasons: ["truth-conflict"],
      evidencePointers: []
    })).toThrow("evidence pointers");
  });

  it("validates ATS parse-back and layout failures separately", () => {
    const valid = validateAtsDocument({
      variant: {
        variantId: "VARIANT-001",
        document: document(),
        templateVersion: "template-1",
        rendererVersion: "renderer-1",
        sourceDocumentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      graph: demoGraph(),
      parseBackText: DEMO_CLAIM_TEXT,
      renderedPageCount: 1,
      overflowDetected: false,
      visibleTextPixelRatio: 0.1,
      targetKeywords: ["synthetic project"]
    }, NOW);
    expect(valid).toMatchObject({ valid: true, traceCoverage: 1, parseBackCoverage: 1, keywordCoverage: 1 });
    const invalid = validateAtsDocument({
      variant: { ...{
        variantId: "VARIANT-002",
        document: document(),
        templateVersion: "",
        rendererVersion: "",
        sourceDocumentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      } },
      graph: demoGraph(),
      parseBackText: "",
      renderedPageCount: 0,
      overflowDetected: true,
      visibleTextPixelRatio: 0,
      targetKeywords: []
    }, NOW);
    expect(invalid.reasons).toEqual(expect.arrayContaining([
      "document-layout-overflow",
      "document-page-count-invalid",
      "document-parse-back-coverage-low",
      "document-render-version-missing",
      "document-visible-text-ratio-invalid"
    ]));
  });

  it("keeps interview and network outputs bounded to supplied evidence", () => {
    const storyResult = evaluateInterviewStory({
      prompt: { promptId: "PROMPT-1", text: "Describe impact", competency: "impact", sourcePointer: "job://prompt/1" },
      story: {
        storyId: "STORY-1",
        title: "Bounded story",
        situationClaimIds: ["CLM-S"],
        taskClaimIds: ["CLM-T"],
        actionClaimIds: ["CLM-A"],
        resultClaimIds: ["CLM-R"],
        reflectionClaimIds: ["CLM-X"],
        permittedRoleFamilies: ["ai"]
      },
      responseClaimIds: ["CLM-S", "CLM-T", "CLM-A", "CLM-R", "CLM-X"],
      durationSeconds: 90,
      fillerCount: 2,
      wordCount: 100
    });
    expect(storyResult).toMatchObject({ status: "pass", fillerRate: 0.02 });
    expect(storyResult.evidencePointers).toContain("job://prompt/1");
    expect(storyResult.evidencePointers).toContain("claim:CLM-R");
    expect(planNetworkOutreach({
      contactId: "CONTACT-ELIGIBLE",
      displayName: "Not returned",
      organization: "Not returned",
      relationship: "public-contact",
      source: "official-directory",
      sourcePointer: "official://directory/contact",
      lastContactAt: null,
      outreachCount90Days: 0
    }, NOW).status).toBe("eligible");
    expect(planNetworkOutreach({
      contactId: "CONTACT-COOLDOWN",
      displayName: "Not returned",
      organization: "Not returned",
      relationship: "known",
      source: "operator",
      sourcePointer: "operator://contact/cooldown",
      lastContactAt: "2026-07-10T10:00:00.000Z",
      outreachCount90Days: 3
    }, NOW)).toMatchObject({ status: "cooldown", reasons: ["network-contact-cooldown", "network-fatigue-limit"] });
  });

  it("uses fixed specialist codes and low confidence for high-stakes offer estimates", () => {
    const result = analyzeOfferScenario({
      offerId: "OFFER-COMPAT-001",
      components: [
        { componentId: "salary", label: "Salary", annualValue: 80_000, currency: "EUR", confidence: "High", sourcePointer: "offer://salary" },
        { componentId: "benefit", label: "Benefit", annualValue: 5_000, currency: "USD", confidence: "High", sourcePointer: "offer://benefit" }
      ],
      conversionRates: { EUR: 1.1 },
      targetCurrency: "USD",
      annualCostOfLiving: 40_000,
      annualTaxEstimate: 20_000,
      highStakesFlags: ["tax liability", "work authorization"]
    });
    expect(result).toMatchObject({ grossAnnualValue: 93_000, disposableAnnualEstimate: 33_000, confidence: "Low" });
    expect(result.specialistQuestions).toEqual([
      "tax-specialist-verification-required",
      "work-authorization-specialist-verification-required"
    ]);
    expect(result.specialistQuestions.every((code) => COMPATIBILITY_OFFER_SPECIALIST_QUESTION_CODES.includes(code))).toBe(true);
  });

  it("covers counterfactual review and eligible states", () => {
    expect(analyzeCounterfactualRoute(snapshot(), {
      routeId: "ROUTE-REVIEW",
      label: "Review route",
      horizonMonths: 12,
      opens: ["path-a"],
      closes: [],
      strengthenedFactIds: ["FACT-COMPAT-001"],
      weakenedFactIds: [],
      hardDefeaters: [],
      uncertaintyDrivers: ["current-source-required"],
      evidencePointers: ["route://review"],
      reversibleUntil: null
    }).decisionStatus).toBe("review");
    expect(analyzeCounterfactualRoute(snapshot(), {
      routeId: "ROUTE-ELIGIBLE",
      label: "Eligible route",
      horizonMonths: 6,
      opens: ["path-a"],
      closes: ["path-b"],
      strengthenedFactIds: [],
      weakenedFactIds: ["FACT-COMPAT-001"],
      hardDefeaters: [],
      uncertaintyDrivers: [],
      evidencePointers: ["route://eligible"],
      reversibleUntil: "2026-08-01T00:00:00.000Z"
    })).toMatchObject({ decisionStatus: "eligible", optionalityDelta: 0 });
  });

  it("rolls back on calibration and rejects undeclared variants", () => {
    const calibrationRollback = assessSequentialExperiment(experimentPolicy, [
      outcome("BASE-1", "BASE", 0, 0.9),
      outcome("BASE-2", "BASE", 0, 0.9),
      outcome("CANDIDATE-1", "CANDIDATE", 0, 0.9),
      outcome("CANDIDATE-2", "CANDIDATE", 0, 0.9)
    ]);
    expect(calibrationRollback).toMatchObject({ status: "rollback-candidate", causalClaimAllowed: false });
    expect(calibrationRollback.reasons).toContain("calibration-threshold-exceeded");
    expect(assessSequentialExperiment(experimentPolicy, [outcome("BASE-ONLY", "BASE", 1, 0.8)]).status).toBe("insufficient-data");
    expect(() => assessSequentialExperiment(experimentPolicy, [{
      ...outcome("UNKNOWN", "BASE", 1, 0.8),
      variantId: "UNDECLARED"
    }])).toThrow("undeclared variant");
  });
});
