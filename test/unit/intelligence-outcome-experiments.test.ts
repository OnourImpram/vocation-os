import { describe, expect, it } from "vitest";
import { createOutcomeEvent, registerSequentialExperiment } from "../../src/outcome-learning.js";
import {
  applySequentialExperimentEvaluation,
  evaluateSequentialExperiment,
  type SequentialExperimentObservation,
  type SequentialExperimentPolicy
} from "../../src/intelligence/index.js";

const START = "2026-07-14T08:00:00.000Z";

function experiment() {
  return registerSequentialExperiment({
    hypothesis: "A bounded document variant may correlate with observed offer rate",
    changedVariable: "document",
    baselineVariantId: "DOC-BASELINE",
    candidateVariantId: "DOC-CANDIDATE",
    approvalId: "APR-EXPERIMENT-001",
    startedAt: START
  });
}

const policy: SequentialExperimentPolicy = {
  minimumObservationsPerVariant: 2,
  maximumObservationsPerVariant: 20,
  calibrationBins: 5,
  maximumCandidateBrierScore: 0.3,
  maximumCandidateCalibrationError: 0.4,
  maximumObservedRateDrop: 0.25,
  successStages: ["offer", "accepted"],
  failureStages: ["rejected", "withdrawn"]
};

function observation(
  observationId: string,
  variantId: "DOC-BASELINE" | "DOC-CANDIDATE",
  stage: "offer" | "rejected",
  probability: number,
  safetyBreaches: SequentialExperimentObservation["safetyBreaches"] = []
): SequentialExperimentObservation {
  return {
    observationId,
    variantId,
    predictedProbability: probability,
    outcomeEvent: createOutcomeEvent({
      opportunityId: `OPP-${observationId}`,
      stage,
      occurredAt: "2026-07-14T10:00:00.000Z",
      source: "operator",
      modelVersion: "model-1",
      policyVersion: "policy-1",
      documentVariantId: variantId,
      messageVariantId: null,
      evidencePointer: `outcome://${observationId}`
    }),
    safetyBreaches,
    evidenceRefs: [`observation://${observationId}`]
  };
}

describe("sequential outcome experiments", () => {
  it("rolls back a poorly calibrated candidate without making a causal claim", () => {
    const active = experiment();
    const evaluation = evaluateSequentialExperiment(active, [
      observation("BASE-1", "DOC-BASELINE", "offer", 0.8),
      observation("BASE-2", "DOC-BASELINE", "offer", 0.8),
      observation("CANDIDATE-1", "DOC-CANDIDATE", "rejected", 0.9),
      observation("CANDIDATE-2", "DOC-CANDIDATE", "rejected", 0.9)
    ], policy);
    expect(evaluation).toMatchObject({
      inferenceMode: "descriptive-sequential-observation-not-causal",
      decision: "rollback",
      nextStatus: "rolled-back",
      rollbackVariantId: "DOC-BASELINE"
    });
    expect(evaluation.reasonCodes).toContain("EXPERIMENT_ROLLBACK_CALIBRATION");
    expect(applySequentialExperimentEvaluation(active, evaluation).status).toBe("rolled-back");
  });

  it("rolls back immediately on a safety breach before the sample threshold", () => {
    const evaluation = evaluateSequentialExperiment(experiment(), [
      observation("CANDIDATE-SAFETY", "DOC-CANDIDATE", "rejected", 0.2, ["hard-gate-bypass"])
    ], policy);
    expect(evaluation.decision).toBe("rollback");
    expect(evaluation.reasonCodes).toContain("EXPERIMENT_ROLLBACK_SAFETY");
    expect(evaluation.safetyBreaches).toEqual(["hard-gate-bypass"]);
  });

  it("continues descriptively when the endpoint sample is insufficient", () => {
    const evaluation = evaluateSequentialExperiment(experiment(), [], policy);
    expect(evaluation).toMatchObject({ decision: "continue", nextStatus: "active" });
    expect(evaluation.reasonCodes).toContain("EXPERIMENT_INSUFFICIENT_SAMPLE");
    expect(evaluation.observedRateDifference).toBeNull();
  });
});
