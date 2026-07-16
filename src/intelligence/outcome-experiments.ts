import { brierScore, expectedCalibrationError } from "../benchmark/vocation-bench.js";
import {
  OUTCOME_STAGES,
  type CareerOutcomeEvent,
  type OutcomeStage,
  type SequentialExperiment
} from "../outcome-learning.js";
import {
  assertEvidenceRefs,
  assertFiniteRange,
  intelligenceAssertion,
  roundMetric,
  uniqueEvidenceRefs,
  type IntelligenceAssertion,
  type IntelligenceAssertionCode
} from "./assertions.js";

export const EXPERIMENT_SAFETY_BREACH_CODES = [
  "claim-integrity-failure",
  "authorization-bypass",
  "privacy-incident",
  "hard-gate-bypass",
  "confirmation-failure"
] as const;

export type ExperimentSafetyBreachCode = (typeof EXPERIMENT_SAFETY_BREACH_CODES)[number];

export interface SequentialExperimentObservation {
  observationId: string;
  variantId: string;
  predictedProbability: number;
  outcomeEvent: CareerOutcomeEvent;
  safetyBreaches: ExperimentSafetyBreachCode[];
  evidenceRefs: string[];
}

export interface SequentialExperimentPolicy {
  minimumObservationsPerVariant: number;
  maximumObservationsPerVariant: number;
  calibrationBins: number;
  maximumCandidateBrierScore: number;
  maximumCandidateCalibrationError: number;
  maximumObservedRateDrop: number;
  successStages: OutcomeStage[];
  failureStages: OutcomeStage[];
}

export interface ExperimentVariantMetrics {
  variantId: string;
  sampleSize: number;
  observedRate: number | null;
  brierScore: number | null;
  expectedCalibrationError: number | null;
  evidenceRefs: string[];
}

export interface SequentialExperimentEvaluation {
  experimentId: string;
  inferenceMode: "descriptive-sequential-observation-not-causal";
  decision: "continue" | "pause-for-review" | "rollback";
  nextStatus: "active" | "stopped" | "rolled-back";
  rollbackVariantId: string | null;
  baseline: ExperimentVariantMetrics;
  candidate: ExperimentVariantMetrics;
  observedRateDifference: number | null;
  reasonCodes: IntelligenceAssertionCode[];
  safetyBreaches: ExperimentSafetyBreachCode[];
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

interface NormalizedObservation {
  observation: SequentialExperimentObservation;
  observedOutcome: 0 | 1;
  evidenceRefs: string[];
}

function validatePolicy(policy: SequentialExperimentPolicy): void {
  if (!Number.isInteger(policy.minimumObservationsPerVariant) || policy.minimumObservationsPerVariant < 1) {
    throw new Error("Experiment minimum observations must be a positive integer");
  }
  if (!Number.isInteger(policy.maximumObservationsPerVariant) || policy.maximumObservationsPerVariant < policy.minimumObservationsPerVariant) {
    throw new Error("Experiment maximum observations must be at least the minimum");
  }
  if (!Number.isInteger(policy.calibrationBins) || policy.calibrationBins < 2) {
    throw new Error("Experiment calibration bins must be an integer of at least two");
  }
  assertFiniteRange(policy.maximumCandidateBrierScore, 0, 1, "Experiment maximum Brier score");
  assertFiniteRange(policy.maximumCandidateCalibrationError, 0, 1, "Experiment maximum calibration error");
  assertFiniteRange(policy.maximumObservedRateDrop, 0, 1, "Experiment maximum observed rate drop");
  if (policy.successStages.length === 0 || policy.failureStages.length === 0) {
    throw new Error("Experiment endpoints require success and failure stages");
  }
  if (new Set(policy.successStages).size !== policy.successStages.length || new Set(policy.failureStages).size !== policy.failureStages.length) {
    throw new Error("Experiment endpoint stages must be unique");
  }
  const validStages = new Set<OutcomeStage>(OUTCOME_STAGES);
  if ([...policy.successStages, ...policy.failureStages].some((stage) => !validStages.has(stage))) {
    throw new Error("Experiment endpoint contains an unsupported stage");
  }
  if (policy.successStages.some((stage) => policy.failureStages.includes(stage))) {
    throw new Error("Experiment success and failure stages must be disjoint");
  }
}

function variantMatchesEvent(experiment: SequentialExperiment, variantId: string, event: CareerOutcomeEvent): boolean {
  if (experiment.changedVariable === "document") return event.documentVariantId === variantId;
  if (experiment.changedVariable === "message") return event.messageVariantId === variantId;
  return true;
}

function variantMetrics(
  variantId: string,
  observations: NormalizedObservation[],
  calibrationBins: number
): ExperimentVariantMetrics {
  const members = observations.filter((entry) => entry.observation.variantId === variantId);
  if (members.length === 0) {
    return { variantId, sampleSize: 0, observedRate: null, brierScore: null, expectedCalibrationError: null, evidenceRefs: [] };
  }
  const ranked = members.map((entry) => ({
    relevance: 0,
    predictedProbability: entry.observation.predictedProbability,
    observedOutcome: entry.observedOutcome
  }));
  return {
    variantId,
    sampleSize: members.length,
    observedRate: roundMetric(members.reduce((sum, entry) => sum + entry.observedOutcome, 0) / members.length),
    brierScore: roundMetric(brierScore(ranked)),
    expectedCalibrationError: roundMetric(expectedCalibrationError(ranked, calibrationBins)),
    evidenceRefs: uniqueEvidenceRefs(members.map((entry) => entry.evidenceRefs))
  };
}

export function evaluateSequentialExperiment(
  experiment: SequentialExperiment,
  observations: SequentialExperimentObservation[],
  policy: SequentialExperimentPolicy
): SequentialExperimentEvaluation {
  validatePolicy(policy);
  if (experiment.status !== "active") throw new Error("Only an active sequential experiment can be evaluated");
  if (!experiment.approvalId.startsWith("APR-")) throw new Error("Sequential experiment approval id is invalid");
  const observationIds = observations.map((entry) => entry.observationId);
  const opportunityIds = observations.map((entry) => entry.outcomeEvent.opportunityId);
  const outcomeIds = observations.map((entry) => entry.outcomeEvent.outcomeId);
  if (new Set(observationIds).size !== observationIds.length) throw new Error("Experiment observation ids must be unique");
  if (new Set(opportunityIds).size !== opportunityIds.length) throw new Error("Each experiment opportunity can contribute only one endpoint observation");
  if (new Set(outcomeIds).size !== outcomeIds.length) throw new Error("Experiment outcome event ids must be unique");
  const successStages = new Set(policy.successStages);
  const failureStages = new Set(policy.failureStages);
  const startedAt = Date.parse(experiment.startedAt);
  if (!Number.isFinite(startedAt)) throw new Error("Sequential experiment start time is invalid");

  const normalized: NormalizedObservation[] = observations.map((observation) => {
    if (!observation.observationId.trim()) throw new Error("Experiment observation id is required");
    if (observation.variantId !== experiment.baselineVariantId && observation.variantId !== experiment.candidateVariantId) {
      throw new Error(`Experiment observation ${observation.observationId} uses an undeclared variant`);
    }
    assertFiniteRange(observation.predictedProbability, 0, 1, `Experiment probability for ${observation.observationId}`);
    if (!variantMatchesEvent(experiment, observation.variantId, observation.outcomeEvent)) {
      throw new Error(`Experiment observation ${observation.observationId} is not bound to its document or message variant`);
    }
    const occurredAt = Date.parse(observation.outcomeEvent.occurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt < startedAt) {
      throw new Error(`Experiment observation ${observation.observationId} predates the experiment`);
    }
    if (!observation.outcomeEvent.evidencePointer.trim()) {
      throw new Error(`Experiment observation ${observation.observationId} lacks outcome evidence`);
    }
    const succeeded = successStages.has(observation.outcomeEvent.stage);
    const failed = failureStages.has(observation.outcomeEvent.stage);
    if (!succeeded && !failed) throw new Error(`Experiment observation ${observation.observationId} is not a declared endpoint`);
    const evidenceRefs = uniqueEvidenceRefs([
      assertEvidenceRefs(observation.evidenceRefs, `Experiment observation ${observation.observationId}`),
      [observation.outcomeEvent.evidencePointer, `outcome:${observation.outcomeEvent.outcomeId}`]
    ]);
    return { observation, observedOutcome: succeeded ? 1 : 0, evidenceRefs };
  });

  const baseline = variantMetrics(experiment.baselineVariantId, normalized, policy.calibrationBins);
  const candidate = variantMetrics(experiment.candidateVariantId, normalized, policy.calibrationBins);
  const observedRateDifference = baseline.observedRate === null || candidate.observedRate === null
    ? null
    : roundMetric(candidate.observedRate - baseline.observedRate);
  const safetyBreaches = [...new Set(normalized.flatMap((entry) => entry.observation.safetyBreaches))].sort();
  const enoughData = baseline.sampleSize >= policy.minimumObservationsPerVariant
    && candidate.sampleSize >= policy.minimumObservationsPerVariant;
  let decision: SequentialExperimentEvaluation["decision"] = "continue";
  let reasonCode: IntelligenceAssertionCode;
  if (safetyBreaches.length > 0) {
    decision = "rollback";
    reasonCode = "EXPERIMENT_ROLLBACK_SAFETY";
  } else if (
    candidate.sampleSize >= policy.minimumObservationsPerVariant
    && ((candidate.brierScore ?? 0) > policy.maximumCandidateBrierScore
      || (candidate.expectedCalibrationError ?? 0) > policy.maximumCandidateCalibrationError)
  ) {
    decision = "rollback";
    reasonCode = "EXPERIMENT_ROLLBACK_CALIBRATION";
  } else if (enoughData && observedRateDifference !== null && observedRateDifference < -policy.maximumObservedRateDrop) {
    decision = "rollback";
    reasonCode = "EXPERIMENT_ROLLBACK_ADVERSE_RATE";
  } else if (
    baseline.sampleSize >= policy.maximumObservationsPerVariant
    && candidate.sampleSize >= policy.maximumObservationsPerVariant
  ) {
    decision = "pause-for-review";
    reasonCode = "EXPERIMENT_MAX_SAMPLE_REACHED";
  } else if (!enoughData) {
    reasonCode = "EXPERIMENT_INSUFFICIENT_SAMPLE";
  } else {
    reasonCode = "EXPERIMENT_CONTINUE";
  }
  const nextStatus = decision === "rollback" ? "rolled-back" : decision === "pause-for-review" ? "stopped" : "active";
  const evidenceRefs = uniqueEvidenceRefs(normalized.map((entry) => entry.evidenceRefs));
  const assertions = [
    intelligenceAssertion("EXPERIMENT_DESCRIPTIVE_ONLY", "policy"),
    intelligenceAssertion(reasonCode, decision === "continue" && !enoughData ? "policy" : "calculation", evidenceRefs)
  ];
  if (decision === "pause-for-review") assertions.push(intelligenceAssertion("EXPERIMENT_PAUSE_FOR_REVIEW", "policy"));

  return {
    experimentId: experiment.experimentId,
    inferenceMode: "descriptive-sequential-observation-not-causal",
    decision,
    nextStatus,
    rollbackVariantId: decision === "rollback" ? experiment.baselineVariantId : null,
    baseline,
    candidate,
    observedRateDifference,
    reasonCodes: assertions.map((assertion) => assertion.code),
    safetyBreaches,
    evidenceRefs,
    assertions
  };
}

export function applySequentialExperimentEvaluation(
  experiment: SequentialExperiment,
  evaluation: SequentialExperimentEvaluation
): SequentialExperiment {
  if (evaluation.experimentId !== experiment.experimentId) throw new Error("Experiment evaluation id mismatch");
  return { ...experiment, status: evaluation.nextStatus };
}
