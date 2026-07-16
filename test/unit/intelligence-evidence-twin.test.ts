import { describe, expect, it } from "vitest";
import { createCareerTwin, type TemporalCareerFact } from "../../src/career-twin.js";
import {
  diffCareerTwinRecords,
  evaluateCounterfactualOptionality,
  intelligenceAssertion
} from "../../src/intelligence/index.js";

const NOW = new Date("2026-07-14T10:00:00.000Z");

function fact(value = "TypeScript"): TemporalCareerFact {
  return {
    factId: "FACT-SKILL-001",
    category: "skill",
    label: "Typed software delivery",
    value,
    validFrom: "2026-01-01T00:00:00.000Z",
    observedAt: "2026-07-14T09:00:00.000Z",
    evidenceStatus: "operator_supplied",
    sourcePointer: "operator://facts/skill-001",
    confidence: "Medium",
    sensitivity: "internal",
    allowedUses: ["analysis"]
  };
}

describe("intelligence evidence and career twin analysis", () => {
  it("requires evidence for evidence-based assertions", () => {
    expect(() => intelligenceAssertion("CAREER_TWIN_FACT_CHANGED", "evidence")).toThrow("requires an evidence reference");
    expect(intelligenceAssertion("COUNTERFACTUAL_SCENARIO_ONLY", "policy")).toEqual({
      code: "COUNTERFACTUAL_SCENARIO_ONLY",
      basis: "policy",
      evidenceRefs: []
    });
  });

  it("diffs newer twin records without exposing changed fact values", () => {
    const previous = createCareerTwin("synthetic", [fact("TypeScript")], [{
      goalId: "GOAL-BUILD-001",
      label: "Build infrastructure",
      horizon: "one-year",
      priority: 60,
      status: "active"
    }], NOW);
    const current = {
      ...previous,
      twinVersion: 2,
      updatedAt: "2026-07-14T11:00:00.000Z",
      facts: [fact("Advanced TypeScript")],
      goals: [{ ...previous.goals[0]!, priority: 80 }]
    };
    const diff = diffCareerTwinRecords(previous, current);
    expect(diff.factChanges[0]).toMatchObject({ factId: "FACT-SKILL-001", change: "changed", changedFields: ["value"] });
    expect(diff.goalChanges[0]).toMatchObject({ goalId: "GOAL-BUILD-001", changedFields: ["priority"] });
    expect(JSON.stringify(diff)).not.toContain("Advanced TypeScript");
    expect(diff.factChanges[0]?.evidenceRefs).toContain("operator://facts/skill-001");
  });

  it("models optionality descriptively while preserving route hard gates", () => {
    const twin = createCareerTwin("synthetic", [fact()], [], NOW);
    const assumptions = [{
      assumptionId: "ASSUME-CREDENTIAL",
      factId: "FACT-CREDENTIAL-001",
      state: "present" as const,
      evidenceRefs: ["operator://scenario/credential"]
    }];
    const result = evaluateCounterfactualOptionality(twin, {
      scenarioId: "SCENARIO-001",
      at: NOW,
      assumptions,
      routes: [
        {
          routeId: "ROUTE-OPENED",
          requiredFactIds: ["FACT-CREDENTIAL-001"],
          hardGates: [],
          evidenceRefs: ["evidence://routes/opened"]
        },
        {
          routeId: "ROUTE-GATED",
          requiredFactIds: ["FACT-SKILL-001"],
          hardGates: ["license-unverified"],
          evidenceRefs: ["evidence://routes/gated"]
        }
      ]
    });
    expect(result.interpretation).toBe("scenario-comparison-not-causal");
    expect(result.openedRouteIds).toEqual(["ROUTE-OPENED"]);
    expect(result.counterfactual.find((route) => route.routeId === "ROUTE-GATED")?.feasible).toBe(false);
    expect(result.assertions.map((assertion) => assertion.code)).toContain("COUNTERFACTUAL_ROUTE_HARD_GATED");
    expect(assumptions[0]?.evidenceRefs).toEqual(["operator://scenario/credential"]);
  });
});
