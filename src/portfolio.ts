export const PORTFOLIO_OBJECTIVES = [
  "income",
  "learning",
  "prestige",
  "immigration-evidence",
  "health-sustainability",
  "family-fit",
  "identity-congruence",
  "reputation",
  "optionality"
] as const;

export type PortfolioObjective = (typeof PORTFOLIO_OBJECTIVES)[number];

export interface CareerOption {
  optionId: string;
  label: string;
  routeType: "job" | "fellowship" | "postdoc" | "grant" | "consulting" | "teaching" | "speaking" | "publishing" | "venture";
  scores: Record<PortfolioObjective, number>;
  uncertaintyBand: [number, number];
  failedGates: string[];
}

export interface PortfolioWeights extends Record<PortfolioObjective, number> {}

export interface PortfolioEvaluation {
  optionId: string;
  utility: number | null;
  weightedRegret: number | null;
  paretoEfficient: boolean;
  excludedBy: string[];
}

function validateOption(option: CareerOption): void {
  for (const objective of PORTFOLIO_OBJECTIVES) {
    const value = option.scores[objective];
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error(`Portfolio score for ${option.optionId}:${objective} must be an integer from 0 to 100`);
    }
  }
  const [low, high] = option.uncertaintyBand;
  if (low < 0 || high > 100 || low > high) throw new Error(`Invalid uncertainty band for ${option.optionId}`);
}

function normalizedWeights(weights: PortfolioWeights): PortfolioWeights {
  const values = PORTFOLIO_OBJECTIVES.map((objective) => weights[objective]);
  if (values.some((weight) => !Number.isFinite(weight) || weight < 0)) throw new Error("Portfolio weights must be finite and non-negative");
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new Error("At least one portfolio weight must be positive");
  return Object.fromEntries(PORTFOLIO_OBJECTIVES.map((objective) => [objective, weights[objective] / total])) as PortfolioWeights;
}

function dominates(left: CareerOption, right: CareerOption): boolean {
  const neverWorse = PORTFOLIO_OBJECTIVES.every((objective) => left.scores[objective] >= right.scores[objective]);
  const sometimesBetter = PORTFOLIO_OBJECTIVES.some((objective) => left.scores[objective] > right.scores[objective]);
  return neverWorse && sometimesBetter;
}

export function paretoFrontier(options: CareerOption[]): CareerOption[] {
  options.forEach(validateOption);
  const feasible = options.filter((option) => option.failedGates.length === 0);
  return feasible.filter((candidate) => !feasible.some((other) => other.optionId !== candidate.optionId && dominates(other, candidate)));
}

export function evaluateCareerPortfolio(options: CareerOption[], weights: PortfolioWeights): PortfolioEvaluation[] {
  const ids = new Set<string>();
  for (const option of options) {
    validateOption(option);
    if (ids.has(option.optionId)) throw new Error(`Duplicate career option id: ${option.optionId}`);
    ids.add(option.optionId);
  }
  const normalized = normalizedWeights(weights);
  const frontierIds = new Set(paretoFrontier(options).map((option) => option.optionId));
  const feasible = options.filter((option) => option.failedGates.length === 0);
  const ideal = Object.fromEntries(
    PORTFOLIO_OBJECTIVES.map((objective) => [objective, Math.max(...feasible.map((option) => option.scores[objective]), 0)])
  ) as Record<PortfolioObjective, number>;

  return options.map((option) => {
    if (option.failedGates.length > 0) {
      return { optionId: option.optionId, utility: null, weightedRegret: null, paretoEfficient: false, excludedBy: [...option.failedGates] };
    }
    const utility = PORTFOLIO_OBJECTIVES.reduce((sum, objective) => sum + option.scores[objective] * normalized[objective], 0);
    const weightedRegret = PORTFOLIO_OBJECTIVES.reduce(
      (sum, objective) => sum + (ideal[objective] - option.scores[objective]) * normalized[objective],
      0
    );
    return {
      optionId: option.optionId,
      utility: Number(utility.toFixed(2)),
      weightedRegret: Number(weightedRegret.toFixed(2)),
      paretoEfficient: frontierIds.has(option.optionId),
      excludedBy: []
    };
  }).sort((left, right) => (right.utility ?? -1) - (left.utility ?? -1));
}
