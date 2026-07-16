import { expectedCalibrationError, type RankedItem } from "../benchmark/vocation-bench.js";

export interface OutcomeObservation {
  observationId: string;
  experimentId: string;
  opportunityId: string;
  variantId: string;
  outcome: 0 | 1;
  predictedProbability: number;
  observedAt: string;
  evidencePointer: string;
}

export interface ExperimentPolicy {
  experimentId: string;
  approvedVariable: "document" | "message" | "targeting" | "timing";
  baselineVariantId: string;
  candidateVariantId: string;
  minimumObservationsPerVariant: number;
  maximumEce: number;
  rollbackIfCandidateRateBelowBaselineBy: number;
  approvalId: string;
}

export interface ExperimentAssessment {
  experimentId: string;
  status: "insufficient-data" | "continue" | "rollback-candidate" | "complete-review";
  baselineRate: number | null;
  candidateRate: number | null;
  calibrationError: number | null;
  reasons: string[];
  causalClaimAllowed: false;
  evidencePointers: string[];
}

function rate(values: OutcomeObservation[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value.outcome, 0) / values.length).toFixed(4));
}

export function assessSequentialExperiment(
  policy: ExperimentPolicy,
  observations: OutcomeObservation[]
): ExperimentAssessment {
  if (!policy.approvalId.startsWith("APR-")) throw new Error("Outcome experiment requires explicit approval");
  if (policy.baselineVariantId === policy.candidateVariantId) throw new Error("Outcome experiment variants must differ");
  if (!Number.isSafeInteger(policy.minimumObservationsPerVariant) || policy.minimumObservationsPerVariant < 2) {
    throw new Error("Outcome experiment minimum sample must be at least two per variant");
  }
  if (policy.maximumEce < 0 || policy.maximumEce > 1) throw new Error("Outcome experiment maximum ECE is invalid");
  const scoped = observations.filter((observation) => observation.experimentId === policy.experimentId);
  const opportunityIds = scoped.map((observation) => observation.opportunityId);
  if (new Set(opportunityIds).size !== opportunityIds.length) {
    throw new Error("Each outcome experiment opportunity can contribute only one observation");
  }
  for (const observation of scoped) {
    if (!observation.evidencePointer.trim()) throw new Error("Outcome observation evidence pointer is required");
    if (observation.predictedProbability < 0 || observation.predictedProbability > 1) {
      throw new Error("Outcome observation probability is invalid");
    }
    if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error("Outcome observation timestamp is invalid");
    if (observation.variantId !== policy.baselineVariantId && observation.variantId !== policy.candidateVariantId) {
      throw new Error("Outcome observation uses an undeclared variant");
    }
  }
  const baseline = scoped.filter((observation) => observation.variantId === policy.baselineVariantId);
  const candidate = scoped.filter((observation) => observation.variantId === policy.candidateVariantId);
  const evidencePointers = [...new Set(scoped.map((observation) => observation.evidencePointer))].sort();
  const baselineRate = rate(baseline);
  const candidateRate = rate(candidate);
  if (baseline.length < policy.minimumObservationsPerVariant || candidate.length < policy.minimumObservationsPerVariant) {
    return {
      experimentId: policy.experimentId,
      status: "insufficient-data",
      baselineRate,
      candidateRate,
      calibrationError: null,
      reasons: ["minimum-observation-threshold-not-met"],
      causalClaimAllowed: false,
      evidencePointers
    };
  }
  const ranked: RankedItem[] = [...baseline, ...candidate].map((observation) => ({
    relevance: observation.outcome,
    predictedProbability: observation.predictedProbability,
    observedOutcome: observation.outcome
  }));
  const calibrationError = Number(expectedCalibrationError(ranked).toFixed(4));
  const reasons: string[] = [];
  let status: ExperimentAssessment["status"] = "continue";
  if (calibrationError > policy.maximumEce) {
    status = "rollback-candidate";
    reasons.push("calibration-threshold-exceeded");
  }
  if (baselineRate !== null && candidateRate !== null && baselineRate - candidateRate >= policy.rollbackIfCandidateRateBelowBaselineBy) {
    status = "rollback-candidate";
    reasons.push("candidate-performance-below-rollback-threshold");
  } else if (calibrationError <= policy.maximumEce) {
    status = "complete-review";
    reasons.push("minimum-sample-and-calibration-gates-met");
  }
  return {
    experimentId: policy.experimentId,
    status,
    baselineRate,
    candidateRate,
    calibrationError,
    reasons,
    causalClaimAllowed: false,
    evidencePointers
  };
}
