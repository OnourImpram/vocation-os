import { describe, expect, it } from "vitest";
import { brierScore, createVocationBenchManifest, expectedCalibrationError, f1Score, generateVocationBenchFixtures, ndcgAt, safetyBenchmark } from "../../src/benchmark/vocation-bench.js";

describe("VocationBench", () => {
  it("publishes the committed synthetic benchmark scale", () => {
    expect(createVocationBenchManifest(new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      profileCount: 500,
      opportunityCount: 1000,
      adversarialCaseCount: 200,
      proofCaseCount: 100
    });
  });

  it("materializes deterministic synthetic fixture sets", () => {
    const fixtures = generateVocationBenchFixtures();
    expect(fixtures.profiles).toHaveLength(500);
    expect(fixtures.opportunities).toHaveLength(1000);
    expect(fixtures.adversarialCases).toHaveLength(200);
    expect(fixtures.proofCases).toHaveLength(100);
    expect(fixtures.proofCases.filter((fixture) => fixture.forged).every((fixture) => !fixture.expectedConfirmed)).toBe(true);
  });

  it("computes ranking and calibration metrics", () => {
    const perfect = [
      { relevance: 3, predictedProbability: 0.9, observedOutcome: 1 as const },
      { relevance: 2, predictedProbability: 0.7, observedOutcome: 1 as const },
      { relevance: 0, predictedProbability: 0.1, observedOutcome: 0 as const }
    ];
    expect(ndcgAt(perfect, 3)).toBeCloseTo(1, 8);
    expect(brierScore(perfect)).toBeLessThan(0.1);
    expect(expectedCalibrationError(perfect, 5)).toBeLessThan(0.3);
  });

  it("requires zero false allows and confirmations for a safety pass", () => {
    expect(safetyBenchmark(0, 200, 0, 100).passed).toBe(true);
    expect(safetyBenchmark(1, 200, 0, 100).passed).toBe(false);
  });

  it("computes duplicate detection F1", () => {
    expect(f1Score({ truePositive: 97, falsePositive: 2, falseNegative: 1 })).toBeGreaterThan(0.97);
  });

  it("rejects invalid metric inputs instead of reporting optimistic results", () => {
    expect(() => expectedCalibrationError([{ relevance: 1, predictedProbability: 1.5, observedOutcome: 1 }])).toThrow(
      "Probabilities must be between 0 and 1"
    );
    expect(() => ndcgAt([{ relevance: -1 }], 1)).toThrow("Relevance grades");
    expect(() => f1Score({ truePositive: 1, falsePositive: -1, falseNegative: 0 })).toThrow("non-negative integers");
    expect(() => safetyBenchmark(201, 200, 0, 100)).toThrow("cannot exceed");
  });
});
