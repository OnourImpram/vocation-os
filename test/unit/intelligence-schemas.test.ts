import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv, type AnySchema } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { describe, expect, it } from "vitest";
import { INTELLIGENCE_ASSERTION_CODES } from "../../src/intelligence/index.js";

const SCHEMA_FILES = [
  "intelligence-assertion.schema.json",
  "intelligence-career-twin.schema.json",
  "intelligence-portfolio.schema.json",
  "intelligence-campaign.schema.json",
  "intelligence-ats-document.schema.json",
  "intelligence-interview.schema.json",
  "intelligence-network.schema.json",
  "intelligence-offer.schema.json",
  "intelligence-outcome-experiment.schema.json"
] as const;

function intelligenceAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const addFormats = addFormatsModule as unknown as { default?: (instance: Ajv) => void };
  const applyFormats = addFormats.default ?? (addFormatsModule as unknown as (instance: Ajv) => void);
  applyFormats(ajv);
  for (const file of SCHEMA_FILES) {
    const source = readFileSync(path.resolve("schemas", file), "utf8");
    ajv.addSchema(JSON.parse(source) as AnySchema);
  }
  return ajv;
}

const policyAssertion = {
  code: "COUNTERFACTUAL_SCENARIO_ONLY",
  basis: "policy",
  evidenceRefs: []
};

describe("intelligence JSON schemas", () => {
  it("compiles every bounded intelligence schema", () => {
    const ajv = intelligenceAjv();
    for (const file of SCHEMA_FILES) {
      const id = `https://vocation-os.dev/schemas/${file}`;
      expect(ajv.getSchema(id), id).toBeTypeOf("function");
    }
  });

  it("rejects open vocabulary and unbound evidence assertions", () => {
    const validate = intelligenceAjv().getSchema("https://vocation-os.dev/schemas/intelligence-assertion.schema.json");
    expect(validate).toBeDefined();
    expect(validate?.({ code: "FREEFORM_CLAIM", basis: "policy", evidenceRefs: [] })).toBe(false);
    expect(validate?.({ code: "CAREER_TWIN_FACT_CHANGED", basis: "evidence", evidenceRefs: [] })).toBe(false);
    expect(validate?.({ code: "CAREER_TWIN_FACT_CHANGED", basis: "evidence", evidenceRefs: ["claim://1"] })).toBe(true);
  });

  it("keeps the assertion schema vocabulary synchronized with TypeScript", () => {
    const schema = JSON.parse(readFileSync(path.resolve("schemas", "intelligence-assertion.schema.json"), "utf8")) as {
      properties: { code: { enum: string[] } };
    };
    expect(schema.properties.code.enum).toEqual([...INTELLIGENCE_ASSERTION_CODES]);
  });

  it("accepts representative safe outputs for every domain schema", () => {
    const ajv = intelligenceAjv();
    const scores = {
      income: 80,
      learning: 80,
      prestige: 80,
      "immigration-evidence": 80,
      "health-sustainability": 80,
      "family-fit": 80,
      "identity-congruence": 80,
      reputation: 80,
      optionality: 80
    };
    const examples: Record<string, unknown> = {
      "intelligence-career-twin.schema.json": {
        scenarioId: "SCENARIO-1",
        interpretation: "scenario-comparison-not-causal",
        baseline: [],
        counterfactual: [],
        openedRouteIds: [],
        closedRouteIds: [],
        modeledOptionalityDelta: 0,
        evidenceRefs: [],
        assertions: [policyAssertion]
      },
      "intelligence-portfolio.schema.json": [{
        portfolioId: "PORTFOLIO-1",
        routeIds: ["ROUTE-1"],
        status: "feasible",
        quotaStatus: "not-met",
        scores,
        uncertaintyBand: [70, 90],
        utility: 80,
        weightedRegret: 0,
        paretoEfficient: true,
        hardGatedRouteIds: [],
        capacityHardGate: false,
        evidenceRefs: ["route://1"],
        assertions: [
          { code: "PORTFOLIO_PARETO_EFFICIENT", basis: "calculation", evidenceRefs: ["route://1"] },
          { code: "PORTFOLIO_DIVERSITY_QUOTA_UNMET", basis: "policy", evidenceRefs: [] }
        ]
      }],
      "intelligence-campaign.schema.json": {
        campaignId: "CAM-1",
        policyVersion: "policy-1",
        generatedAt: "2026-07-14T10:00:00.000Z",
        entries: [],
        dispositions: [],
        assertions: []
      },
      "intelligence-ats-document.schema.json": {
        documentId: "DOC-1",
        targetId: "TARGET-1",
        status: "review-required",
        claimTraceCoverage: 1,
        parseBackCoverage: 1,
        requiredSectionCoverage: 1,
        termCoverage: 1,
        missingSectionKeys: [],
        missingTermIds: [],
        documentValidationIssueCount: 0,
        evidenceRefs: ["hash://1"],
        assertions: [
          { code: "ATS_DOCUMENT_STRUCTURE_VALIDATED", basis: "calculation", evidenceRefs: [] },
          { code: "ATS_PARSEBACK_VALIDATED", basis: "calculation", evidenceRefs: ["hash://1"] },
          { code: "ATS_REVIEW_REQUIRED", basis: "policy", evidenceRefs: [] }
        ]
      },
      "intelligence-interview.schema.json": {
        storyId: "STORY-1",
        valid: false,
        reasonCodes: ["claim-private"],
        missingSegments: [],
        invalidClaimIds: ["CLM-1"],
        evidenceRefs: ["claim://1"],
        assertions: [{ code: "INTERVIEW_STORY_INVALID", basis: "policy", evidenceRefs: [] }]
      },
      "intelligence-network.schema.json": {
        contactDiscovery: "disabled",
        dispositions: [],
        plannedRequestIds: [],
        blockedRequestIds: [],
        assertions: []
      },
      "intelligence-offer.schema.json": [{
        scenarioId: "OFFER-1",
        status: "scenario-only",
        currency: "USD",
        guaranteedAnnualRange: [100, 100],
        modeledAnnualRange: [90, 110],
        nonFinancialScore: 70,
        paretoEfficient: true,
        hardGates: [],
        specialistQuestionCodes: [],
        evidenceRefs: ["offer://1"],
        assertions: [
          { code: "OFFER_NOT_A_CERTAINTY", basis: "policy", evidenceRefs: [] },
          { code: "OFFER_SCENARIO_MODELED", basis: "calculation", evidenceRefs: ["offer://1"] }
        ]
      }],
      "intelligence-outcome-experiment.schema.json": {
        experimentId: "EXP-1",
        inferenceMode: "descriptive-sequential-observation-not-causal",
        decision: "continue",
        nextStatus: "active",
        rollbackVariantId: null,
        baseline: { variantId: "BASE", sampleSize: 0, observedRate: null, brierScore: null, expectedCalibrationError: null, evidenceRefs: [] },
        candidate: { variantId: "CANDIDATE", sampleSize: 0, observedRate: null, brierScore: null, expectedCalibrationError: null, evidenceRefs: [] },
        observedRateDifference: null,
        reasonCodes: ["EXPERIMENT_DESCRIPTIVE_ONLY", "EXPERIMENT_INSUFFICIENT_SAMPLE"],
        safetyBreaches: [],
        evidenceRefs: [],
        assertions: [
          { code: "EXPERIMENT_DESCRIPTIVE_ONLY", basis: "policy", evidenceRefs: [] },
          { code: "EXPERIMENT_INSUFFICIENT_SAMPLE", basis: "policy", evidenceRefs: [] }
        ]
      }
    };
    for (const [file, example] of Object.entries(examples)) {
      const validate = ajv.getSchema(`https://vocation-os.dev/schemas/${file}`);
      expect(validate?.(example), `${file}: ${JSON.stringify(validate?.errors)}`).toBe(true);
    }
  });
});
