import { describe, expect, it } from "vitest";
import {
  createVerificationObservation,
  evaluateVerificationBundle,
  type VerificationObservationDraft
} from "../../src/career-ops/verification.js";

const BASE: Omit<VerificationObservationDraft, "sourceKind" | "sourceUrl" | "applyUrl" | "capturedAt" | "sourcePayload"> = {
  opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
  employer: "Synthetic Research Labs",
  roleTitle: "Research Operations Lead",
  requisitionId: "REQ-001",
  locationText: "Remote, European Union",
  postedAt: "2026-08-27T08:00:00.000Z",
  deadlineAt: "2026-09-10T21:00:00.000Z",
  observedStatus: "live",
  extractionConfidence: "high"
};

function observation(
  sourceKind: VerificationObservationDraft["sourceKind"],
  overrides: Partial<VerificationObservationDraft> = {}
) {
  const isIndependent = sourceKind === "independent";
  return createVerificationObservation({
    ...BASE,
    sourceKind,
    sourceUrl: isIndependent
      ? "https://synthetic.example/careers/research-operations-lead"
      : "https://boards.greenhouse.io/synthetic/jobs/1001",
    applyUrl: "https://boards.greenhouse.io/synthetic/jobs/1001#app",
    capturedAt: sourceKind === "primary"
      ? "2026-08-28T08:00:00.000Z"
      : sourceKind === "independent"
        ? "2026-08-28T08:02:00.000Z"
        : "2026-08-28T08:05:00.000Z",
    sourcePayload: { sourceKind, status: "open", requisition: "REQ-001" },
    ...overrides
  });
}

function evaluate(overrides: Partial<Parameters<typeof evaluateVerificationBundle>[0]> = {}) {
  return evaluateVerificationBundle({
    opportunityId: BASE.opportunityId,
    primary: observation("primary"),
    independent: observation("independent"),
    preAction: observation("pre-action"),
    policy: {
      maximumPreActionAgeSeconds: 600,
      bundleLifetimeSeconds: 3600
    },
    evaluatedAt: "2026-08-28T08:06:00.000Z",
    ...overrides
  });
}

describe("career operations opportunity verification", () => {
  it("accepts three current and materially consistent observations from independent source families", () => {
    const result = evaluate();

    expect(result.status).toBe("verified");
    expect(result.reasons).toEqual([]);
    expect(result.primaryObservationId).toMatch(/^OBS-/);
    expect(result.independentObservationId).toMatch(/^OBS-/);
    expect(result.preActionObservationId).toMatch(/^OBS-/);
    expect(result.bundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects the primary page reused as independent corroboration after tracking parameters are removed", () => {
    const primary = observation("primary");
    const independent = observation("independent", {
      sourceUrl: "https://boards.greenhouse.io/synthetic/jobs/1001?utm_source=mirror",
      applyUrl: "https://boards.greenhouse.io/synthetic/jobs/1001#app"
    });

    const result = evaluate({ primary, independent });

    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("independent observation is not source-independent");
  });

  it("marks a material requisition conflict as conflicted", () => {
    const independent = observation("independent", { requisitionId: "REQ-999" });

    const result = evaluate({ independent });

    expect(result.status).toBe("conflicted");
    expect(result.reasons).toContain("requisition id conflicts across verification observations");
  });

  it("rejects a closed primary listing before any downstream action", () => {
    const primary = observation("primary", { observedStatus: "closed" });

    const result = evaluate({ primary });

    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("primary observation is not live");
  });

  it("expires verification when the pre-action observation is older than policy allows", () => {
    const preAction = observation("pre-action", { capturedAt: "2026-08-28T07:30:00.000Z" });

    const result = evaluate({ preAction });

    expect(result.status).toBe("expired");
    expect(result.reasons).toContain("pre-action observation is older than the allowed execution window");
  });

  it("rejects non-HTTPS verification sources", () => {
    expect(() => observation("primary", {
      sourceUrl: "http://boards.greenhouse.io/synthetic/jobs/1001"
    })).toThrow("verification source URLs must use HTTPS");
  });
});
