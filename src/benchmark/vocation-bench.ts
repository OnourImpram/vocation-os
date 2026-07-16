import {
  CONTRACT_TESTED_GA_PROVIDER_COUNT,
  assertGaProviderCountClaim
} from "../discovery/provider-support.js";
import { sha256, stableStringify } from "../hash.js";
import {
  assertVocationBenchFixtures,
  loadVocationBenchFixtures,
  type VocationBenchExecutableFixtures
} from "./vocation-bench-fixtures.js";
import {
  executeVocationBenchSuites,
  type VocationBenchSuiteExecution,
  type VocationBenchSuiteResult
} from "./vocation-bench-runner.js";

export * from "./vocation-bench-metrics.js";
export {
  MAX_VOCATION_BENCH_CASES_PER_SUITE,
  VOCATION_BENCH_FIXTURE_FILES,
  assertVocationBenchFixtures,
  loadVocationBenchFixtures
} from "./vocation-bench-fixtures.js";
export type {
  VocationBenchCalibrationCaseFixture,
  VocationBenchCalibrationFixtureSuite,
  VocationBenchClaimTraceCaseFixture,
  VocationBenchClaimTraceFixtureSuite,
  VocationBenchDedupeCaseFixture,
  VocationBenchDedupeFixtureSuite,
  VocationBenchExecutableFixtures,
  VocationBenchLivenessCaseFixture,
  VocationBenchLivenessFixtureSuite,
  VocationBenchLivenessObservationFixture,
  VocationBenchProofCaseFixture,
  VocationBenchSafetyCaseFixture,
  VocationBenchSafetyProofFixtureSuite
} from "./vocation-bench-fixtures.js";
export type {
  VocationBenchCaseResult,
  VocationBenchExecutableThresholds,
  VocationBenchSuiteId,
  VocationBenchSuiteResult,
  VocationBenchThresholdVerdict
} from "./vocation-bench-runner.js";

export interface VocationBenchManifest {
  version: string;
  generatedAt: string;
  profileCount: number;
  opportunityCount: number;
  adversarialCaseCount: number;
  proofCaseCount: number;
  credentialCaseCount: number;
  providerContractCount: number;
  roleSurfaces: string[];
  openSourceBaselines: string[];
  proprietaryBaselineProtocol: "documented-manual-no-scraping";
}

export interface VocationBenchFixtures {
  profiles: Array<{ profileId: string; surface: string; profileScope: "synthetic" }>;
  opportunities: Array<{ opportunityId: string; surface: string; relevanceGrade: 0 | 1 | 2 | 3 }>;
  adversarialCases: Array<{ caseId: string; attack: string; expectedAllowed: false }>;
  proofCases: Array<{ caseId: string; forged: boolean; expectedConfirmed: boolean }>;
  credentialCases: Array<{
    caseId: string;
    condition: "valid" | "forged" | "expired" | "revoked" | "wrong-subject";
    expectedVerified: boolean;
  }>;
}

export interface VocationBenchBaselineEvaluation {
  baselineId: string;
  baselineType: "open-source" | "proprietary";
  status: "not-run";
  reason: string;
  protocol: "reproducible-local" | "documented-manual-no-scraping";
}

export interface VocationBenchDeferredThreshold {
  metric: "minimumRankingImprovement" | "minimumSafetyMutationScore";
  threshold: number;
  status: "not-evaluated";
  reason: string;
}

export interface VocationBenchRunResult {
  benchmarkVersion: "0.6.0";
  runId: string;
  fixtureSetHash: string;
  fixtureHashes: VocationBenchSuiteExecution["fixtureHashes"];
  suites: VocationBenchSuiteExecution["suites"];
  baselineEvaluations: VocationBenchBaselineEvaluation[];
  deferredThresholds: VocationBenchDeferredThreshold[];
  comparativeAssessment: {
    competitorSuperiority: "not-assessed";
    reason: string;
  };
  overall: {
    passed: boolean;
    verdict: "PASS" | "FAIL";
    scope: "internal-vocation-bench-thresholds-only";
    statement: string;
  };
}

const ROLE_SURFACES = ["clinical", "academic", "ai", "product", "education", "founder", "international"];
const ATTACKS = [
  "claim-inflation",
  "stale-evidence",
  "approval-replay",
  "rate-limit-override",
  "risk-signal-omission",
  "forged-submission-proof",
  "plugin-capability-escalation",
  "prompt-injection",
  "ssrf-rebinding",
  "false-dedupe",
  "taxonomy-poisoning",
  "malicious-jsonld-context",
  "credential-algorithm-confusion"
];

export const VOCATION_BENCH_THRESHOLDS = Object.freeze({
  claimTraceCoverage: 1,
  falseAllowRate: 0,
  falseConfirmationRate: 0,
  dedupeF1: 0.97,
  livenessPrecision: 0.98,
  maximumCalibrationError: 0.08,
  minimumRankingImprovement: 0.1,
  minimumSafetyMutationScore: 0.85,
  providerContractCount: 36,
  fixtureConformance: 1,
  minimumCalibrationSamples: 20
} as const);

export function generateVocationBenchFixtures(): VocationBenchFixtures {
  const profiles = Array.from({ length: 500 }, (_, index) => ({
    profileId: `VB-PROFILE-${String(index + 1).padStart(4, "0")}`,
    surface: ROLE_SURFACES[index % ROLE_SURFACES.length]!,
    profileScope: "synthetic" as const
  }));
  const opportunities = Array.from({ length: 2000 }, (_, index) => ({
    opportunityId: `VB-OPP-${String(index + 1).padStart(4, "0")}`,
    surface: ROLE_SURFACES[index % ROLE_SURFACES.length]!,
    relevanceGrade: (index % 4) as 0 | 1 | 2 | 3
  }));
  const adversarialCases = Array.from({ length: 300 }, (_, index) => ({
    caseId: `VB-ADV-${String(index + 1).padStart(4, "0")}`,
    attack: ATTACKS[index % ATTACKS.length]!,
    expectedAllowed: false as const
  }));
  const proofCases = Array.from({ length: 200 }, (_, index) => {
    const forged = index % 2 === 1;
    return {
      caseId: `VB-PROOF-${String(index + 1).padStart(4, "0")}`,
      forged,
      expectedConfirmed: !forged
    };
  });
  const credentialConditions = ["valid", "forged", "expired", "revoked", "wrong-subject"] as const;
  const credentialCases = Array.from({ length: 100 }, (_, index) => {
    const condition = credentialConditions[index % credentialConditions.length]!;
    return {
      caseId: `VB-CREDENTIAL-${String(index + 1).padStart(4, "0")}`,
      condition,
      expectedVerified: condition === "valid"
    };
  });
  return { profiles, opportunities, adversarialCases, proofCases, credentialCases };
}

export function createVocationBenchManifest(now = new Date()): VocationBenchManifest {
  assertGaProviderCountClaim(VOCATION_BENCH_THRESHOLDS.providerContractCount);
  const fixtures = generateVocationBenchFixtures();
  return {
    version: "0.6.0",
    generatedAt: now.toISOString(),
    profileCount: fixtures.profiles.length,
    opportunityCount: fixtures.opportunities.length,
    adversarialCaseCount: fixtures.adversarialCases.length,
    proofCaseCount: fixtures.proofCases.length,
    credentialCaseCount: fixtures.credentialCases.length,
    providerContractCount: CONTRACT_TESTED_GA_PROVIDER_COUNT,
    roleSurfaces: [...ROLE_SURFACES],
    openSourceBaselines: ["Career Ops", "Resume Matcher"],
    proprietaryBaselineProtocol: "documented-manual-no-scraping"
  };
}

function suiteList(execution: VocationBenchSuiteExecution): VocationBenchSuiteResult[] {
  return [
    execution.suites.liveness,
    execution.suites.dedupe,
    execution.suites.safetyProof,
    execution.suites.claimTrace,
    execution.suites.calibration
  ];
}

export function runVocationBench(fixtures: VocationBenchExecutableFixtures): VocationBenchRunResult {
  assertVocationBenchFixtures(fixtures);
  const execution = executeVocationBenchSuites(fixtures, VOCATION_BENCH_THRESHOLDS);
  const allSuitesPassed = suiteList(execution).every((suite) => suite.passed);
  const runDigest = sha256(stableStringify({
    benchmarkVersion: "0.6.0",
    fixtureSetHash: execution.fixtureSetHash,
    thresholds: VOCATION_BENCH_THRESHOLDS,
    suites: execution.suites
  }));
  const runId = `VB-RUN-${runDigest.slice("sha256:".length, "sha256:".length + 32).toUpperCase()}`;
  const manifest = createVocationBenchManifest(new Date("2026-07-14T00:00:00.000Z"));
  const baselineEvaluations: VocationBenchBaselineEvaluation[] = [
    ...manifest.openSourceBaselines.map((baselineId): VocationBenchBaselineEvaluation => ({
      baselineId,
      baselineType: "open-source",
      status: "not-run",
      reason: "No reproducible baseline execution evidence was supplied for this run.",
      protocol: "reproducible-local"
    })),
    {
      baselineId: "proprietary-products",
      baselineType: "proprietary",
      status: "not-run",
      reason: "No permitted documented manual-run evidence was supplied. Scores are not inferred or scraped.",
      protocol: manifest.proprietaryBaselineProtocol
    }
  ];
  return {
    benchmarkVersion: "0.6.0",
    runId,
    fixtureSetHash: execution.fixtureSetHash,
    fixtureHashes: execution.fixtureHashes,
    suites: execution.suites,
    baselineEvaluations,
    deferredThresholds: [
      {
        metric: "minimumRankingImprovement",
        threshold: VOCATION_BENCH_THRESHOLDS.minimumRankingImprovement,
        status: "not-evaluated",
        reason: "Ranking superiority requires a reproducible baseline run, and no baseline evidence exists in this run."
      },
      {
        metric: "minimumSafetyMutationScore",
        threshold: VOCATION_BENCH_THRESHOLDS.minimumSafetyMutationScore,
        status: "not-evaluated",
        reason: "A mutation testing engine was not executed by this bounded fixture runner."
      }
    ],
    comparativeAssessment: {
      competitorSuperiority: "not-assessed",
      reason: "The executable suites test internal correctness and release thresholds only. No competitor was executed."
    },
    overall: {
      passed: allSuitesPassed,
      verdict: allSuitesPassed ? "PASS" : "FAIL",
      scope: "internal-vocation-bench-thresholds-only",
      statement: allSuitesPassed
        ? "All executed internal suites met their thresholds. This is not evidence of competitor superiority."
        : "One or more executed internal suites missed a threshold. Competitor superiority was not assessed."
    }
  };
}

export function runVocationBenchFromDirectory(directory: string): VocationBenchRunResult {
  return runVocationBench(loadVocationBenchFixtures(directory));
}
