import { describe, expect, it } from "vitest";
import type { CareerOption, PortfolioWeights } from "../../src/portfolio.js";
import {
  analyzeMultiRoutePortfolios,
  buildCampaignReviewQueue,
  type CampaignReviewCandidate,
  type MultiRoutePortfolio
} from "../../src/intelligence/index.js";

const weights: PortfolioWeights = {
  income: 1,
  learning: 1,
  prestige: 1,
  "immigration-evidence": 1,
  "health-sustainability": 1,
  "family-fit": 1,
  "identity-congruence": 1,
  reputation: 1,
  optionality: 1
};

function option(optionId: string, routeType: CareerOption["routeType"], score: number, failedGates: string[] = []): CareerOption {
  return {
    optionId,
    label: optionId,
    routeType,
    scores: {
      income: score,
      learning: score,
      prestige: score,
      "immigration-evidence": score,
      "health-sustainability": score,
      "family-fit": score,
      "identity-congruence": score,
      reputation: score,
      optionality: score
    },
    uncertaintyBand: [Math.max(0, score - 5), Math.min(100, score + 5)],
    failedGates
  };
}

function portfolio(portfolioId: string, routes: Array<[CareerOption, number]>): MultiRoutePortfolio {
  return {
    portfolioId,
    allocations: routes.map(([route, allocationPercent]) => ({
      option: route,
      allocationPercent,
      evidenceRefs: [`evidence://portfolio/${route.optionId}`]
    }))
  };
}

describe("multi-route portfolio and campaign policy", () => {
  it("keeps hard-gated routes excluded even when they improve score or diversity quota", () => {
    const results = analyzeMultiRoutePortfolios([
      portfolio("PORTFOLIO-GATED", [
        [option("ROUTE-SAFE", "job", 80), 50],
        [option("ROUTE-BLOCKED", "consulting", 100, ["license-not-verified"]), 50]
      ]),
      portfolio("PORTFOLIO-SINGLE", [[option("ROUTE-HIGH", "job", 90), 100]]),
      portfolio("PORTFOLIO-DIVERSE", [
        [option("ROUTE-JOB", "job", 75), 50],
        [option("ROUTE-CONSULTING", "consulting", 75), 50]
      ])
    ], weights, { maxConcurrentRoutes: 3, minimumRouteTypes: 2 });
    expect(results.find((entry) => entry.portfolioId === "PORTFOLIO-GATED")).toMatchObject({
      status: "hard-gated",
      quotaStatus: "met",
      utility: null,
      paretoEfficient: false,
      hardGatedRouteIds: ["ROUTE-BLOCKED"]
    });
    expect(results.find((entry) => entry.portfolioId === "PORTFOLIO-SINGLE")).toMatchObject({
      status: "feasible",
      quotaStatus: "not-met",
      utility: 90
    });
  });

  it("builds a human review queue only after membership, hard-gate, and quality checks", () => {
    const candidates: CampaignReviewCandidate[] = [
      {
        opportunityId: "OPP-GATED",
        routeType: "job",
        qualityScore: 100,
        confidence: "High",
        hardGates: ["license-unverified"],
        evidenceRefs: ["evidence://campaign/gated"]
      },
      {
        opportunityId: "OPP-ELIGIBLE",
        routeType: "job",
        qualityScore: 90,
        confidence: "High",
        hardGates: [],
        evidenceRefs: ["evidence://campaign/eligible"]
      },
      {
        opportunityId: "OPP-LOW",
        routeType: "consulting",
        qualityScore: 60,
        confidence: "Medium",
        hardGates: [],
        evidenceRefs: ["evidence://campaign/low"]
      }
    ];
    const queue = buildCampaignReviewQueue(
      { campaignId: "CAM-TEST-001", opportunityIds: candidates.map((candidate) => candidate.opportunityId) },
      candidates,
      {
        policyVersion: "review-policy-1",
        minimumQualityScore: 75,
        dailyReviewLimit: 1,
        routeReviewQuotas: { job: 1 }
      },
      new Date("2026-07-14T10:00:00.000Z")
    );
    expect(queue.entries.map((entry) => entry.opportunityId)).toEqual(["OPP-ELIGIBLE"]);
    expect(queue.dispositions.find((entry) => entry.opportunityId === "OPP-GATED")?.status).toBe("hard-gated");
    expect(queue.dispositions.find((entry) => entry.opportunityId === "OPP-LOW")?.status).toBe("below-threshold");
    expect(queue.entries[0]?.reviewRequired).toBe(true);
  });
});
