import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_VOCATION_BENCH_CASES_PER_SUITE,
  VOCATION_BENCH_FIXTURE_FILES,
  brierScore,
  createVocationBenchManifest,
  expectedCalibrationError,
  f1Score,
  generateVocationBenchFixtures,
  loadVocationBenchFixtures,
  ndcgAt,
  runVocationBench,
  runVocationBenchFromDirectory,
  safetyBenchmark,
  type VocationBenchExecutableFixtures
} from "../../src/benchmark/vocation-bench.js";

const FIXTURE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/vocation-bench");

function fixtures(): VocationBenchExecutableFixtures {
  return loadVocationBenchFixtures(FIXTURE_DIRECTORY);
}

function writeFixtureBundle(directory: string, bundle: VocationBenchExecutableFixtures): void {
  const files: Array<[string, unknown]> = [
    [VOCATION_BENCH_FIXTURE_FILES.liveness, bundle.liveness],
    [VOCATION_BENCH_FIXTURE_FILES.dedupe, bundle.dedupe],
    [VOCATION_BENCH_FIXTURE_FILES.safetyProof, bundle.safetyProof],
    [VOCATION_BENCH_FIXTURE_FILES.claimTrace, bundle.claimTrace],
    [VOCATION_BENCH_FIXTURE_FILES.calibration, bundle.calibration]
  ];
  files.forEach(([fileName, value]) => {
    writeFileSync(path.join(directory, fileName), `${JSON.stringify(value)}\n`, "utf8");
  });
}

describe("VocationBench", () => {
  it("preserves the committed synthetic manifest scale", () => {
    expect(createVocationBenchManifest(new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      version: "0.6.0",
      generatedAt: "2026-07-11T00:00:00.000Z",
      profileCount: 500,
      opportunityCount: 2000,
      adversarialCaseCount: 300,
      proofCaseCount: 200,
      credentialCaseCount: 100,
      providerContractCount: 36
    });
  });

  it("materializes deterministic synthetic manifest fixtures without candidate data", () => {
    const generated = generateVocationBenchFixtures();
    expect(generated.profiles).toHaveLength(500);
    expect(generated.opportunities).toHaveLength(2000);
    expect(generated.adversarialCases).toHaveLength(300);
    expect(generated.proofCases).toHaveLength(200);
    expect(generated.credentialCases).toHaveLength(100);
    expect(generated.profiles.every((fixture) => fixture.profileScope === "synthetic")).toBe(true);
    expect(generated.proofCases.filter((fixture) => fixture.forged).every((fixture) => !fixture.expectedConfirmed)).toBe(true);
    expect(generated.credentialCases.filter((fixture) => fixture.expectedVerified)).toHaveLength(20);
  });

  it("executes every suite with deterministic hashes, metrics, and run identity", () => {
    const first = runVocationBenchFromDirectory(FIXTURE_DIRECTORY);
    const second = runVocationBenchFromDirectory(FIXTURE_DIRECTORY);

    expect(second).toEqual(first);
    expect(first.runId).toMatch(/^VB-RUN-[A-F0-9]{32}$/);
    expect(first.fixtureSetHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.values(first.fixtureHashes)).toHaveLength(5);
    expect(Object.values(first.fixtureHashes).every((hash) => /^sha256:[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(first.overall).toMatchObject({
      passed: true,
      verdict: "PASS",
      scope: "internal-vocation-bench-thresholds-only"
    });
    expect(first.suites.liveness.metrics).toMatchObject({ precision: 1, recall: 1, stateAccuracy: 1 });
    expect(first.suites.dedupe.metrics).toMatchObject({ f1: 1, outcomeAccuracy: 1 });
    expect(first.suites.safetyProof.metrics).toMatchObject({
      falseAllowRate: 0,
      falseConfirmationRate: 0,
      safetyClassificationAccuracy: 1,
      proofClassificationAccuracy: 1
    });
    expect(first.suites.claimTrace.metrics).toMatchObject({
      claimTraceCoverage: 1,
      caseAccuracy: 1,
      adversarialDetectionRate: 1
    });
    expect(first.suites.calibration.metrics).toMatchObject({
      expectedCalibrationError: 0,
      brierScore: 0.09,
      sampleCount: 20
    });
    expect(Object.values(first.suites).every((suite) => suite.passed)).toBe(true);
  });

  it("keeps comparison claims and every unexecuted baseline explicit", () => {
    const report = runVocationBench(fixtures());
    expect(report.comparativeAssessment).toMatchObject({ competitorSuperiority: "not-assessed" });
    expect(report.overall.statement).toContain("not evidence of competitor superiority");
    expect(report.baselineEvaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({ baselineId: "Career Ops", baselineType: "open-source", status: "not-run" }),
      expect.objectContaining({ baselineId: "Resume Matcher", baselineType: "open-source", status: "not-run" }),
      expect.objectContaining({ baselineId: "proprietary-products", baselineType: "proprietary", status: "not-run" })
    ]));
    expect(report.baselineEvaluations.every((baseline) => baseline.status === "not-run")).toBe(true);
    expect(report.deferredThresholds).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "minimumRankingImprovement", threshold: 0.1, status: "not-evaluated" }),
      expect.objectContaining({ metric: "minimumSafetyMutationScore", threshold: 0.85, status: "not-evaluated" })
    ]));
    expect(report.deferredThresholds).toHaveLength(2);
  });

  it("runs adversarial cases through product policies rather than accepting fixture labels", () => {
    const report = runVocationBench(fixtures());
    expect(report.suites.liveness.caseResults).toContainEqual(
      expect.objectContaining({ caseId: "VB-LIVE-FUTURE-SKEW", actual: "unresolved", passed: true })
    );
    expect(report.suites.dedupe.caseResults).toContainEqual(
      expect.objectContaining({ caseId: "VB-DEDUPE-RECORD-COLLISION", actual: "distinct", passed: true })
    );
    expect(report.suites.safetyProof.caseResults).toContainEqual(
      expect.objectContaining({ caseId: "VB-SAFETY-CREDENTIAL-FABRICATION", actual: "blocked:credential-fabrication-requested", passed: true })
    );
    expect(report.suites.safetyProof.caseResults).toContainEqual(
      expect.objectContaining({ caseId: "VB-PROOF-TAMPERED-RECEIPT", actual: "rejected", passed: true })
    );
    expect(report.suites.claimTrace.caseResults).toContainEqual(
      expect.objectContaining({ caseId: "VB-TRACE-INJECTED-STRUCTURE", actual: "rejected", passed: true })
    );
  });

  it("fails liveness thresholds and changes run identity when fixture truth is corrupted", () => {
    const original = runVocationBench(fixtures());
    const changed = structuredClone(fixtures());
    changed.liveness.cases[0]!.expectedState = "closed";

    const report = runVocationBench(changed);
    expect(report.suites.liveness.passed).toBe(false);
    expect(report.suites.liveness.failures).toEqual(expect.arrayContaining([
      "threshold:precision",
      "threshold:stateAccuracy",
      "case:VB-LIVE-CURRENT"
    ]));
    expect(report.overall).toMatchObject({ passed: false, verdict: "FAIL" });
    expect(report.fixtureHashes.liveness).not.toBe(original.fixtureHashes.liveness);
    expect(report.runId).not.toBe(original.runId);
  });

  it("fails calibration instead of hiding overconfident predictions", () => {
    const changed = structuredClone(fixtures());
    changed.calibration.cases.forEach((entry) => {
      entry.predictedProbability = 0.99;
    });

    const report = runVocationBench(changed);
    expect(report.suites.calibration.metrics.expectedCalibrationError).toBe(0.49);
    expect(report.suites.calibration.failures).toContain("threshold:expectedCalibrationError");
    expect(report.overall.passed).toBe(false);
  });

  it("rejects fixture sets that exceed the deterministic runtime bound", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "vocation-bench-bound-"));
    try {
      const changed = structuredClone(fixtures());
      changed.calibration.cases = Array.from(
        { length: MAX_VOCATION_BENCH_CASES_PER_SUITE + 1 },
        (_, index) => ({
          caseId: `VB-CAL-BOUND-${String(index + 1).padStart(3, "0")}`,
          predictedProbability: 0.5,
          observedOutcome: (index % 2) as 0 | 1
        })
      );
      writeFixtureBundle(directory, changed);
      expect(() => loadVocationBenchFixtures(directory)).toThrow("runtime bound");
      expect(() => runVocationBench(changed)).toThrow("runtime bound");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized fixture through the opened descriptor before parsing", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "vocation-bench-file-bound-"));
    try {
      writeFileSync(path.join(directory, VOCATION_BENCH_FIXTURE_FILES.liveness), "0".repeat(1_000_001), "utf8");
      expect(() => loadVocationBenchFixtures(directory)).toThrow("byte fixture bound");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("computes ranking, calibration, classification, and safety primitives", () => {
    const perfect = [
      { relevance: 3, predictedProbability: 0.9, observedOutcome: 1 as const },
      { relevance: 2, predictedProbability: 0.7, observedOutcome: 1 as const },
      { relevance: 0, predictedProbability: 0.1, observedOutcome: 0 as const }
    ];
    expect(ndcgAt(perfect, 3)).toBeCloseTo(1, 8);
    expect(brierScore(perfect)).toBeLessThan(0.1);
    expect(expectedCalibrationError(perfect, 5)).toBeLessThan(0.3);
    expect(f1Score({ truePositive: 97, falsePositive: 2, falseNegative: 1 })).toBeGreaterThan(0.97);
    expect(safetyBenchmark(0, 200, 0, 100).passed).toBe(true);
    expect(safetyBenchmark(1, 200, 0, 100).passed).toBe(false);
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
