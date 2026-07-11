import { describe, expect, it } from "vitest";
import { createCareerTwin, currentFacts, validateCareerTwin, type TemporalCareerFact } from "../../src/career-twin.js";

function fact(overrides: Partial<TemporalCareerFact> = {}): TemporalCareerFact {
  return {
    factId: "FACT-DEMO-001",
    category: "skill",
    label: "Synthetic TypeScript skill",
    value: "Can build a small typed CLI",
    claimId: "CLM-DEMO-001",
    validFrom: "2026-01-01T00:00:00.000Z",
    observedAt: "2026-07-11T00:00:00.000Z",
    evidenceStatus: "verified",
    sourcePointer: "examples/demo-profile/source.md#skill",
    confidence: "High",
    sensitivity: "public",
    allowedUses: ["analysis", "cv", "application"],
    ...overrides
  };
}

describe("career digital twin", () => {
  it("creates a valid synthetic temporal profile", () => {
    const twin = createCareerTwin("synthetic", [fact()], [], new Date("2026-07-11T00:00:00.000Z"));
    const validation = validateCareerTwin(twin);
    expect(validation.valid).toBe(true);
    expect(validation.snapshotHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(currentFacts(twin, new Date("2026-07-11T00:00:00.000Z"))).toHaveLength(1);
  });

  it("rejects duplicate fact ids", () => {
    const twin = createCareerTwin("synthetic", [fact()], [], new Date("2026-07-11T00:00:00.000Z"));
    const validation = validateCareerTwin({ ...twin, facts: [fact(), fact()] });
    expect(validation.reasons).toContain("duplicate-fact:FACT-DEMO-001");
  });

  it("rejects sensitive facts exposed to public profile use", () => {
    const twin = createCareerTwin("synthetic", [fact()], [], new Date("2026-07-11T00:00:00.000Z"));
    const validation = validateCareerTwin({
      ...twin,
      facts: [fact({ sensitivity: "sensitive", allowedUses: ["analysis", "public-profile"] })]
    });
    expect(validation.reasons).toContain("sensitive-public-use:FACT-DEMO-001");
  });

  it("filters expired facts from the current snapshot", () => {
    const twin = createCareerTwin("synthetic", [fact({ validTo: "2026-02-01T00:00:00.000Z" })], [], new Date("2026-07-11T00:00:00.000Z"));
    expect(currentFacts(twin, new Date("2026-07-11T00:00:00.000Z"))).toHaveLength(0);
  });
});
