import {
  PORTFOLIO_OBJECTIVES,
  evaluateCareerPortfolio,
  type CareerOption,
  type PortfolioObjective,
  type PortfolioWeights
} from "../portfolio.js";
import {
  assertEvidenceRefs,
  assertFiniteRange,
  intelligenceAssertion,
  uniqueEvidenceRefs,
  type IntelligenceAssertion
} from "./assertions.js";

export interface MultiRouteAllocation {
  option: CareerOption;
  allocationPercent: number;
  evidenceRefs: string[];
}

export interface MultiRoutePortfolio {
  portfolioId: string;
  allocations: MultiRouteAllocation[];
}

export interface MultiRoutePortfolioPolicy {
  maxConcurrentRoutes: number;
  minimumRouteTypes: number;
}

export interface MultiRoutePortfolioEvaluation {
  portfolioId: string;
  routeIds: string[];
  status: "feasible" | "hard-gated";
  quotaStatus: "met" | "not-met";
  scores: Record<PortfolioObjective, number>;
  uncertaintyBand: [number, number];
  utility: number | null;
  weightedRegret: number | null;
  paretoEfficient: boolean;
  hardGatedRouteIds: string[];
  capacityHardGate: boolean;
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

interface PreparedPortfolio {
  candidate: MultiRoutePortfolio;
  aggregate: CareerOption;
  routeIds: string[];
  hardGatedRouteIds: string[];
  capacityHardGate: boolean;
  quotaStatus: MultiRoutePortfolioEvaluation["quotaStatus"];
  evidenceRefs: string[];
}

function validatePolicy(policy: MultiRoutePortfolioPolicy): void {
  if (!Number.isInteger(policy.maxConcurrentRoutes) || policy.maxConcurrentRoutes < 1) {
    throw new Error("Portfolio max concurrent routes must be a positive integer");
  }
  if (!Number.isInteger(policy.minimumRouteTypes) || policy.minimumRouteTypes < 1) {
    throw new Error("Portfolio minimum route types must be a positive integer");
  }
  if (policy.minimumRouteTypes > policy.maxConcurrentRoutes) {
    throw new Error("Portfolio minimum route types cannot exceed max concurrent routes");
  }
}

function preparePortfolio(
  candidate: MultiRoutePortfolio,
  weights: PortfolioWeights,
  policy: MultiRoutePortfolioPolicy
): PreparedPortfolio {
  if (!candidate.portfolioId.trim()) throw new Error("Portfolio id is required");
  if (candidate.allocations.length === 0) throw new Error(`Portfolio ${candidate.portfolioId} requires at least one route`);
  const routeIds = candidate.allocations.map((allocation) => allocation.option.optionId);
  if (new Set(routeIds).size !== routeIds.length) throw new Error(`Portfolio ${candidate.portfolioId} contains duplicate route ids`);

  let totalAllocation = 0;
  const normalizedEvidence: string[][] = [];
  for (const allocation of candidate.allocations) {
    assertFiniteRange(allocation.allocationPercent, Number.EPSILON, 100, `Allocation for ${allocation.option.optionId}`);
    totalAllocation += allocation.allocationPercent;
    normalizedEvidence.push(assertEvidenceRefs(allocation.evidenceRefs, `Portfolio route ${allocation.option.optionId}`));
  }
  if (Math.abs(totalAllocation - 100) > 0.0001) {
    throw new Error(`Portfolio ${candidate.portfolioId} allocations must total 100`);
  }

  // Reuse the established route validator before aggregating route scores.
  evaluateCareerPortfolio(candidate.allocations.map((allocation) => allocation.option), weights);
  const scores = Object.fromEntries(PORTFOLIO_OBJECTIVES.map((objective) => {
    const weighted = candidate.allocations.reduce(
      (sum, allocation) => sum + allocation.option.scores[objective] * allocation.allocationPercent / 100,
      0
    );
    return [objective, Math.round(weighted)];
  })) as Record<PortfolioObjective, number>;
  const uncertaintyBand: [number, number] = [
    candidate.allocations.reduce((sum, allocation) => sum + allocation.option.uncertaintyBand[0] * allocation.allocationPercent / 100, 0),
    candidate.allocations.reduce((sum, allocation) => sum + allocation.option.uncertaintyBand[1] * allocation.allocationPercent / 100, 0)
  ];
  const hardGatedRouteIds = candidate.allocations
    .filter((allocation) => allocation.option.failedGates.length > 0)
    .map((allocation) => allocation.option.optionId)
    .sort();
  const capacityHardGate = candidate.allocations.length > policy.maxConcurrentRoutes;
  const routeTypeCount = new Set(candidate.allocations.map((allocation) => allocation.option.routeType)).size;
  const quotaStatus = routeTypeCount >= policy.minimumRouteTypes ? "met" : "not-met";

  return {
    candidate,
    routeIds: [...routeIds].sort(),
    hardGatedRouteIds,
    capacityHardGate,
    quotaStatus,
    evidenceRefs: uniqueEvidenceRefs(normalizedEvidence),
    aggregate: {
      optionId: candidate.portfolioId,
      label: "multi-route-portfolio",
      routeType: "venture",
      scores,
      uncertaintyBand,
      failedGates: [...(hardGatedRouteIds.length > 0 ? ["route-hard-gate"] : []), ...(capacityHardGate ? ["portfolio-capacity"] : [])]
    }
  };
}

export function analyzeMultiRoutePortfolios(
  portfolios: MultiRoutePortfolio[],
  weights: PortfolioWeights,
  policy: MultiRoutePortfolioPolicy
): MultiRoutePortfolioEvaluation[] {
  validatePolicy(policy);
  const portfolioIds = portfolios.map((portfolio) => portfolio.portfolioId);
  if (new Set(portfolioIds).size !== portfolioIds.length) throw new Error("Multi-route portfolio ids must be unique");
  const prepared = portfolios.map((portfolio) => preparePortfolio(portfolio, weights, policy));
  const aggregateEvaluations = evaluateCareerPortfolio(prepared.map((entry) => entry.aggregate), weights);
  const evaluationById = new Map(aggregateEvaluations.map((evaluation) => [evaluation.optionId, evaluation]));

  return prepared.map((entry) => {
    const evaluation = evaluationById.get(entry.candidate.portfolioId);
    if (!evaluation) throw new Error(`Missing portfolio evaluation for ${entry.candidate.portfolioId}`);
    const status: MultiRoutePortfolioEvaluation["status"] = entry.hardGatedRouteIds.length > 0 || entry.capacityHardGate
      ? "hard-gated"
      : "feasible";
    const assertions: IntelligenceAssertion[] = [];
    if (status === "hard-gated") assertions.push(intelligenceAssertion("PORTFOLIO_HARD_GATED", "policy"));
    else if (evaluation.paretoEfficient) assertions.push(intelligenceAssertion("PORTFOLIO_PARETO_EFFICIENT", "calculation", entry.evidenceRefs));
    else assertions.push(intelligenceAssertion("PORTFOLIO_DOMINATED", "calculation", entry.evidenceRefs));
    assertions.push(intelligenceAssertion(
      entry.quotaStatus === "met" ? "PORTFOLIO_DIVERSITY_QUOTA_MET" : "PORTFOLIO_DIVERSITY_QUOTA_UNMET",
      "policy"
    ));
    return {
      portfolioId: entry.candidate.portfolioId,
      routeIds: entry.routeIds,
      status,
      quotaStatus: entry.quotaStatus,
      scores: entry.aggregate.scores,
      uncertaintyBand: entry.aggregate.uncertaintyBand,
      utility: status === "hard-gated" ? null : evaluation.utility,
      weightedRegret: status === "hard-gated" ? null : evaluation.weightedRegret,
      paretoEfficient: status === "feasible" && evaluation.paretoEfficient,
      hardGatedRouteIds: entry.hardGatedRouteIds,
      capacityHardGate: entry.capacityHardGate,
      evidenceRefs: entry.evidenceRefs,
      assertions
    };
  }).sort((left, right) => (right.utility ?? -1) - (left.utility ?? -1) || left.portfolioId.localeCompare(right.portfolioId));
}
