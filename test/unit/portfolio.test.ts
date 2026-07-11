import { describe, expect, it } from "vitest";
import { evaluateCareerPortfolio, paretoFrontier, type CareerOption, type PortfolioWeights } from "../../src/portfolio.js";

const weights: PortfolioWeights = {
  income: 2,
  learning: 1,
  prestige: 1,
  "immigration-evidence": 2,
  "health-sustainability": 1,
  "family-fit": 1,
  "identity-congruence": 2,
  reputation: 1,
  optionality: 2
};

function option(optionId: string, score: number, overrides: Partial<CareerOption> = {}): CareerOption {
  return {
    optionId,
    label: optionId,
    routeType: "job",
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
    failedGates: [],
    ...overrides
  };
}

describe("career portfolio optimizer", () => {
  it("excludes hard gated routes before utility scoring", () => {
    const results = evaluateCareerPortfolio([option("SAFE", 70), option("BLOCKED", 100, { failedGates: ["license-missing"] })], weights);
    expect(results.find((result) => result.optionId === "BLOCKED")).toMatchObject({ utility: null, excludedBy: ["license-missing"] });
  });

  it("identifies dominated options outside the Pareto frontier", () => {
    expect(paretoFrontier([option("HIGH", 80), option("LOW", 50)]).map((entry) => entry.optionId)).toEqual(["HIGH"]);
  });

  it("returns explicit utility and regret without hiding exclusions", () => {
    const results = evaluateCareerPortfolio([option("A", 80), option("B", 60)], weights);
    expect(results[0]).toMatchObject({ optionId: "A", utility: 80, weightedRegret: 0, paretoEfficient: true });
  });
});
