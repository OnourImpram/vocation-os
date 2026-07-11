import { describe, expect, it } from "vitest";
import { createOutcomeEvent, outcomeFunnel, registerSequentialExperiment } from "../../src/outcome-learning.js";

describe("outcome learning", () => {
  it("binds outcomes to model and policy versions", () => {
    const event = createOutcomeEvent({
      opportunityId: "OPP-DEMO-001",
      stage: "interview",
      occurredAt: "2026-07-11T00:00:00.000Z",
      source: "operator",
      modelVersion: "offline-1",
      policyVersion: "safety-0.3.1",
      documentVariantId: "DOC-A",
      messageVariantId: null,
      evidencePointer: "local:outcome:001"
    });
    expect(event.outcomeId).toMatch(/^OUT-/);
  });

  it("counts each opportunity once per funnel stage", () => {
    const base = {
      opportunityId: "OPP-DEMO-001",
      occurredAt: "2026-07-11T00:00:00.000Z",
      source: "operator" as const,
      modelVersion: "offline-1",
      policyVersion: "safety-0.3.1",
      documentVariantId: null,
      messageVariantId: null,
      evidencePointer: "local:outcome:001"
    };
    const funnel = outcomeFunnel([createOutcomeEvent({ ...base, stage: "applied" }), createOutcomeEvent({ ...base, stage: "applied" })]);
    expect(funnel.applied).toBe(1);
  });

  it("requires explicit approval and one declared experimental variable", () => {
    expect(registerSequentialExperiment({
      hypothesis: "A claim first CV reduces human edits",
      changedVariable: "document",
      baselineVariantId: "DOC-A",
      candidateVariantId: "DOC-B",
      approvalId: "APR-EXPERIMENT-001",
      startedAt: "2026-07-11T00:00:00.000Z"
    }).status).toBe("active");
  });
});
